import { Logger } from '@nestjs/common/services/logger.service';
import { loadPackage } from '@nestjs/common/utils/load-package.util';
import { EmptyError, fromEvent, lastValueFrom, merge, Observable } from 'rxjs';
import { first, map, share, tap } from 'rxjs/operators';
import { ECONNREFUSED, MQTT_DEFAULT_URL } from '../constants';
import { MqttEvents, MqttEventsMap, MqttStatus } from '../events/mqtt.events';
import { MqttOptions, ReadPacket, WritePacket } from '../interfaces';
import {
  MqttRecord,
  MqttRecordOptions,
} from '../record-builders/mqtt.record-builder';
import { MqttRecordSerializer } from '../serializers/mqtt-record.serializer';
import { ClientProxy } from './client-proxy';

let mqttPackage: any = {};

// To enable type safety for MQTT. This cant be uncommented by default
// because it would require the user to install the mqtt package even if they dont use MQTT
// Otherwise, TypeScript would fail to compile the code.
//
type MqttClient = import('mqtt').MqttClient;
// type MqttClient = any;

/**
 * @publicApi
 */
export class ClientMqtt extends ClientProxy<MqttEvents, MqttStatus> {
  protected readonly logger = new Logger(ClientProxy.name);
  protected readonly subscriptionsCount = new Map<string, number>();
  protected readonly url: string;
  protected mqttClient: MqttClient | null = null;
  protected connectionPromise: Promise<any> | null = null;
  protected isInitialConnection = false;
  protected isReconnecting = false;
  protected pendingEventListeners: Array<{
    event: keyof MqttEvents;
    callback: MqttEvents[keyof MqttEvents];
  }> = [];

  constructor(protected readonly options: Required<MqttOptions>['options']) {
    super();
    this.url = this.getOptionsProp(this.options, 'url') ?? MQTT_DEFAULT_URL;

    mqttPackage = loadPackage('mqtt', ClientMqtt.name, () => require('mqtt'));

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  public getRequestPattern(pattern: string): string {
    return pattern;
  }

  public getResponsePattern(pattern: string): string {
    return `${pattern}/reply`;
  }

  public close() {
    this.mqttClient && this.mqttClient.end();
    this.mqttClient = null;
    this.connectionPromise = null;
    this.pendingEventListeners = [];
  }

  public connect(): Promise<any> {
    if (this.mqttClient) {
      return this.connectionPromise!;
    }
    this.mqttClient = this.createClient();
    this.registerErrorListener(this.mqttClient);
    this.registerOfflineListener(this.mqttClient);
    this.registerReconnectListener(this.mqttClient);
    this.registerConnectListener(this.mqttClient);
    this.registerDisconnectListener(this.mqttClient);
    this.registerCloseListener(this.mqttClient);

    this.pendingEventListeners.forEach(({ event, callback }) =>
      this.mqttClient!.on(event, callback),
    );
    this.pendingEventListeners = [];

    const connect$ = this.connect$(this.mqttClient);
    this.connectionPromise = lastValueFrom(
      this.mergeCloseEvent(this.mqttClient, connect$).pipe(share()),
    ).catch(err => {
      if (err instanceof EmptyError) {
        return;
      }
      throw err;
    });
    return this.connectionPromise;
  }

  public mergeCloseEvent<T = any>(
    instance: MqttClient,
    source$: Observable<T>,
  ): Observable<T> {
    const close$ = fromEvent(instance, MqttEventsMap.CLOSE).pipe(
      tap({
        next: () => {
          this._status$.next(MqttStatus.CLOSED);
        },
      }),
      map((err: any) => {
        throw err;
      }),
    );
    return merge(source$, close$).pipe(first());
  }

  public createClient(): MqttClient {
    return mqttPackage.connect(this.url, this.options as MqttOptions);
  }

  public registerErrorListener(client: MqttClient) {
    client.on(
      MqttEventsMap.ERROR,
      (err: any) => err.code !== ECONNREFUSED && this.logger.error(err),
    );
  }

  public registerOfflineListener(client: MqttClient) {
    client.on(MqttEventsMap.OFFLINE, () => {
      this.connectionPromise = Promise.reject(
        'Error: Connection lost. Trying to reconnect...',
      );

      // Prevent unhandled rejections
      this.connectionPromise.catch(() => {});
      this.logger.error('MQTT broker went offline.');
    });
  }

  public registerReconnectListener(client: MqttClient) {
    client.on(MqttEventsMap.RECONNECT, () => {
      this.isReconnecting = true;
      this._status$.next(MqttStatus.RECONNECTING);

      this.logger.log('MQTT connection lost. Trying to reconnect...');
    });
  }

  public registerDisconnectListener(client: MqttClient) {
    client.on(MqttEventsMap.DISCONNECT, () => {
      this._status$.next(MqttStatus.DISCONNECTED);
    });
  }

  public registerCloseListener(client: MqttClient) {
    client.on(MqttEventsMap.CLOSE, () => {
      this._status$.next(MqttStatus.CLOSED);
    });
  }

  public registerConnectListener(client: MqttClient) {
    client.on(MqttEventsMap.CONNECT, () => {
      this.isReconnecting = false;
      this._status$.next(MqttStatus.CONNECTED);

      this.logger.log('Connected to MQTT broker');
      this.connectionPromise = Promise.resolve();

      if (!this.isInitialConnection) {
        this.isInitialConnection = true;
        client.on('message', this.createResponseCallback());
      }
    });
  }

  public on<
    EventKey extends keyof MqttEvents = keyof MqttEvents,
    EventCallback extends MqttEvents[EventKey] = MqttEvents[EventKey],
  >(event: EventKey, callback: EventCallback) {
    if (this.mqttClient) {
      this.mqttClient.on(event, callback as any);
    } else {
      this.pendingEventListeners.push({ event, callback });
    }
  }

  public unwrap<T>(): T {
    if (!this.mqttClient) {
      throw new Error(
        'Not initialized. Please call the "connect" method first.',
      );
    }
    return this.mqttClient as T;
  }

  public createResponseCallback(): (channel: string, buffer: Buffer) => any {
    return async (channel: string, buffer: Buffer) => {
      const packet = JSON.parse(buffer.toString());
      const { err, response, isDisposed, id } =
        await this.deserializer.deserialize(packet);

      const callback = this.routingMap.get(id);
      if (!callback) {
        return undefined;
      }
      if (isDisposed || err) {
        return callback({
          err,
          response,
          isDisposed: true,
        });
      }
      callback({
        err,
        response,
      });
    };
  }

  protected publish(
    partialPacket: ReadPacket,
    callback: (packet: WritePacket) => any,
  ): () => void {
    try {
      const packet = this.assignPacketId(partialPacket);
      const pattern = this.normalizePattern(partialPacket.pattern);
      const serializedPacket: ReadPacket & Partial<MqttRecord> =
        this.serializer.serialize(packet);

      const responseChannel = this.getResponsePattern(pattern);
      let subscriptionsCount =
        this.subscriptionsCount.get(responseChannel) || 0;

      const publishPacket = () => {
        subscriptionsCount = this.subscriptionsCount.get(responseChannel) || 0;
        this.subscriptionsCount.set(responseChannel, subscriptionsCount + 1);
        this.routingMap.set(packet.id, callback);

        const options = serializedPacket.options;
        delete serializedPacket.options;

        this.mqttClient!.publish(
          this.getRequestPattern(pattern),
          JSON.stringify(serializedPacket),
          this.mergePacketOptions(options),
        );
      };

      if (subscriptionsCount <= 0) {
        this.mqttClient!.subscribe(
          responseChannel,
          (err: any) => !err && publishPacket(),
        );
      } else {
        publishPacket();
      }

      return () => {
        this.unsubscribeFromChannel(responseChannel);
        this.routingMap.delete(packet.id);
      };
    } catch (err) {
      callback({ err });
      return () => {};
    }
  }

  protected dispatchEvent(packet: ReadPacket): Promise<any> {
    const pattern = this.normalizePattern(packet.pattern);
    const serializedPacket: ReadPacket & Partial<MqttRecord> =
      this.serializer.serialize(packet);

    const options = serializedPacket.options;
    delete serializedPacket.options;

    return new Promise<void>((resolve, reject) =>
      this.mqttClient!.publish(
        pattern,
        JSON.stringify(serializedPacket),
        this.mergePacketOptions(options),
        (err: any) => (err ? reject(err) : resolve()),
      ),
    );
  }

  protected unsubscribeFromChannel(channel: string) {
    const subscriptionCount = this.subscriptionsCount.get(channel)!;
    this.subscriptionsCount.set(channel, subscriptionCount - 1);

    if (subscriptionCount - 1 <= 0) {
      this.mqttClient!.unsubscribe(channel);
    }
  }

  protected initializeSerializer(options: MqttOptions['options']) {
    this.serializer = options?.serializer ?? new MqttRecordSerializer();
  }

  protected mergePacketOptions(
    requestOptions?: MqttRecordOptions,
  ): MqttRecordOptions | undefined {
    if (!requestOptions && !this.options?.userProperties) {
      return undefined;
    }

    return {
      ...requestOptions,
      properties: {
        ...requestOptions?.properties,
        userProperties: {
          ...this.options?.userProperties,
          ...requestOptions?.properties?.userProperties,
        },
      },
    };
  }
}
