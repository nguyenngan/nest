import { isNil, isObject } from '@nestjs/common/utils/shared.utils';
import { expect } from 'chai';
import { IncomingMessage, ServerResponse } from 'http';
import { Observable, of, Subject } from 'rxjs';
import * as sinon from 'sinon';
import { PassThrough, Writable } from 'stream';
import { HttpStatus, RequestMethod } from '../../../common';
import { RouterResponseController } from '../../router/router-response-controller';
import { SseStream } from '../../router/sse-stream';
import { NoopHttpAdapter } from '../utils/noop-adapter.spec';

describe('RouterResponseController', () => {
  let adapter: NoopHttpAdapter;
  let routerResponseController: RouterResponseController;

  beforeEach(() => {
    adapter = new NoopHttpAdapter({});
    routerResponseController = new RouterResponseController(adapter);
  });

  describe('apply', () => {
    let response: {
      send: sinon.SinonSpy;
      status?: sinon.SinonSpy;
      json: sinon.SinonSpy;
    };
    beforeEach(() => {
      response = { send: sinon.spy(), json: sinon.spy(), status: sinon.spy() };
    });
    describe('when result is', () => {
      beforeEach(() => {
        sinon
          .stub(adapter, 'reply')
          .callsFake((responseRef: any, body: any, statusCode?: number) => {
            if (statusCode) {
              responseRef.status(statusCode);
            }
            if (isNil(body)) {
              return responseRef.send();
            }
            return isObject(body)
              ? responseRef.json(body)
              : responseRef.send(String(body));
          });
      });
      describe('nil', () => {
        it('should call send()', async () => {
          const value = null;
          await routerResponseController.apply(value, response, 200);
          expect(response.send.called).to.be.true;
        });
      });
      describe('string', () => {
        it('should call send(value)', async () => {
          const value = 'string';
          await routerResponseController.apply(value, response, 200);
          expect(response.send.called).to.be.true;
          expect(response.send.calledWith(String(value))).to.be.true;
        });
      });
      describe('object', () => {
        it('should call json(value)', async () => {
          const value = { test: 'test' };
          await routerResponseController.apply(value, response, 200);
          expect(response.json.called).to.be.true;
          expect(response.json.calledWith(value)).to.be.true;
        });
      });
    });
  });

  describe('transformToResult', () => {
    describe('when resultOrDeferred', () => {
      describe('is Promise', () => {
        it('should return Promise that resolves to the value resolved by the input Promise', async () => {
          const value = 100;
          expect(
            await routerResponseController.transformToResult(
              Promise.resolve(value),
            ),
          ).to.be.eq(value);
        });
      });

      describe('is Observable', () => {
        it('should return toPromise', async () => {
          const lastValue = 100;
          expect(
            await routerResponseController.transformToResult(
              of(1, 2, 3, lastValue),
            ),
          ).to.be.eq(lastValue);
        });
      });

      describe('is an object that has the method `subscribe`', () => {
        it('should return a Promise that resolves to the input value', async () => {
          const value = { subscribe() {} };
          expect(
            await routerResponseController.transformToResult(value),
          ).to.equal(value);
        });
      });

      describe('is an ordinary value', () => {
        it('should return a Promise that resolves to the input value', async () => {
          const value = 100;
          expect(
            await routerResponseController.transformToResult(value),
          ).to.be.eq(value);
        });
      });
    });
  });

  describe('getStatusByMethod', () => {
    describe('when RequestMethod is POST', () => {
      it('should return 201', () => {
        expect(
          routerResponseController.getStatusByMethod(RequestMethod.POST),
        ).to.be.eql(201);
      });
    });
    describe('when RequestMethod is not POST', () => {
      it('should return 200', () => {
        expect(
          routerResponseController.getStatusByMethod(RequestMethod.GET),
        ).to.be.eql(200);
      });
    });
  });

  describe('render', () => {
    beforeEach(() => {
      sinon
        .stub(adapter, 'render')
        .callsFake((response, view: string, options: any) => {
          return response.render(view, options);
        });
    });
    it('should call "res.render()" with expected args', async () => {
      const template = 'template';
      const value = 'test';
      const result = Promise.resolve(value);
      const response = { render: sinon.spy() };

      await routerResponseController.render(result, response, template);
      expect(response.render.calledWith(template, value)).to.be.true;
    });
  });

  describe('setHeaders', () => {
    let setHeaderStub: sinon.SinonStub;

    beforeEach(() => {
      setHeaderStub = sinon.stub(adapter, 'setHeader').callsFake(() => ({}));
    });

    it('should set all custom headers', () => {
      const response = {};
      const headers = [{ name: 'test', value: 'test_value' }];

      routerResponseController.setHeaders(response, headers);
      expect(
        setHeaderStub.calledWith(response, headers[0].name, headers[0].value),
      ).to.be.true;
    });
  });

  describe('status', () => {
    let statusStub: sinon.SinonStub;

    beforeEach(() => {
      statusStub = sinon.stub(adapter, 'status').callsFake(() => ({}));
    });

    it('should set status', () => {
      const response = {};
      const statusCode = 400;

      routerResponseController.setStatus(response, statusCode);
      expect(statusStub.calledWith(response, statusCode)).to.be.true;
    });
  });

  describe('redirect should HttpServer.redirect', () => {
    it('should transformToResult', async () => {
      const transformToResultSpy = sinon
        .stub(routerResponseController, 'transformToResult')
        .returns(Promise.resolve({ statusCode: 123, url: 'redirect url' }));
      const result = {};
      await routerResponseController.redirect(result, null, null!);
      expect(transformToResultSpy.firstCall.args[0]).to.be.equal(result);
    });
    it('should pass the response to redirect', async () => {
      sinon
        .stub(routerResponseController, 'transformToResult')
        .returns(Promise.resolve({ statusCode: 123, url: 'redirect url' }));
      const redirectSpy = sinon.spy(adapter, 'redirect');
      const response = {};
      await routerResponseController.redirect(null, response, null!);
      expect(redirectSpy.firstCall.args[0]).to.be.equal(response);
    });
    describe('status code', () => {
      it('should come from the transformed result if present', async () => {
        sinon
          .stub(routerResponseController, 'transformToResult')
          .returns(Promise.resolve({ statusCode: 123, url: 'redirect url' }));
        const redirectSpy = sinon.spy(adapter, 'redirect');
        await routerResponseController.redirect(null, null, {
          statusCode: 999,
          url: 'not form here',
        });
        expect(redirectSpy.firstCall.args[1]).to.be.eql(123);
      });
      it('should come from the redirectResponse if not on the transformed result', async () => {
        sinon
          .stub(routerResponseController, 'transformToResult')
          .returns(Promise.resolve({}));
        const redirectSpy = sinon.spy(adapter, 'redirect');
        await routerResponseController.redirect(null, null, {
          statusCode: 123,
          url: 'redirect url',
        });
        expect(redirectSpy.firstCall.args[1]).to.be.eql(123);
      });
      it('should default to HttpStatus.FOUND', async () => {
        sinon
          .stub(routerResponseController, 'transformToResult')
          .returns(Promise.resolve({}));
        const redirectSpy = sinon.spy(adapter, 'redirect');
        await routerResponseController.redirect(null, null, {
          url: 'redirect url',
        });
        expect(redirectSpy.firstCall.args[1]).to.be.eql(HttpStatus.FOUND);
      });
    });
    describe('url', () => {
      it('should come from the transformed result if present', async () => {
        sinon
          .stub(routerResponseController, 'transformToResult')
          .returns(Promise.resolve({ statusCode: 123, url: 'redirect url' }));
        const redirectSpy = sinon.spy(adapter, 'redirect');
        await routerResponseController.redirect(null, null, {
          url: 'not from here',
        });
        expect(redirectSpy.firstCall.args[2]).to.be.eql('redirect url');
      });
      it('should come from the redirectResponse if not on the transformed result', async () => {
        sinon
          .stub(routerResponseController, 'transformToResult')
          .returns(Promise.resolve({}));
        const redirectSpy = sinon.spy(adapter, 'redirect');
        await routerResponseController.redirect(null, null, {
          statusCode: 123,
          url: 'redirect url',
        });
        expect(redirectSpy.firstCall.args[2]).to.be.eql('redirect url');
      });
    });
  });
  describe('Server-Sent-Events', () => {
    it('should accept only observables', async () => {
      const result = Promise.resolve('test');
      try {
        routerResponseController.sse(
          result as unknown as any,
          {} as unknown as ServerResponse,
          {} as unknown as IncomingMessage,
        );
      } catch (e) {
        expect(e.message).to.eql(
          'You must return an Observable stream to use Server-Sent Events (SSE).',
        );
      }
    });

    it('should write string', async () => {
      class Sink extends Writable {
        private readonly chunks: string[] = [];

        _write(
          chunk: any,
          encoding: string,
          callback: (error?: Error | null) => void,
        ): void {
          this.chunks.push(chunk);
          callback();
        }

        get content() {
          return this.chunks.join('');
        }
      }

      const written = (stream: Writable) =>
        new Promise((resolve, reject) =>
          stream.on('error', reject).on('finish', resolve),
        );

      const result = of('test');
      const response = new Sink();
      const request = new PassThrough();
      routerResponseController.sse(
        result,
        response as unknown as ServerResponse,
        request as unknown as IncomingMessage,
      );
      request.destroy();
      await written(response);
      expect(response.content).to.eql(
        `
id: 1
data: test

`,
      );
    });

    it('should close on request close', done => {
      const result = of('test');
      const response = new Writable();
      response.end = () => done() as any;
      response._write = () => {};

      const request = new Writable();
      request._write = () => {};

      routerResponseController.sse(
        result,
        response as unknown as ServerResponse,
        request as unknown as IncomingMessage,
      );
      request.emit('close');
    });

    it('should close the request when observable completes', done => {
      const result = of('test');
      const response = new Writable();
      response.end = done as any;
      response._write = () => {};

      const request = new Writable();
      request._write = () => {};

      routerResponseController.sse(
        result,
        response as unknown as ServerResponse,
        request as unknown as IncomingMessage,
      );
    });

    it('should allow to intercept the response', done => {
      const result = sinon.spy();
      const response = new Writable();
      response.end();
      response._write = () => {};

      const request = new Writable();
      request._write = () => {};

      try {
        routerResponseController.sse(
          result as unknown as Observable<string>,
          response as unknown as ServerResponse,
          request as unknown as IncomingMessage,
        );
      } catch {
        // Whether an error is thrown or not
        // is not relevant, so long as
        // result is not called
      }

      sinon.assert.notCalled(result);
      done();
    });

    describe('when writing data too densely', () => {
      const DEFAULT_MAX_LISTENERS = SseStream.defaultMaxListeners;
      const MAX_LISTENERS = 1;
      const sandbox = sinon.createSandbox();

      beforeEach(() => {
        // Can't access to the internal sseStream,
        // as a workaround, set `defaultMaxListeners` of `SseStream` and reset the max listeners of `process`
        const PROCESS_MAX_LISTENERS = process.getMaxListeners();
        SseStream.defaultMaxListeners = MAX_LISTENERS;
        process.setMaxListeners(PROCESS_MAX_LISTENERS);

        const sseStream = sinon.createStubInstance(SseStream);
        const originalWrite = SseStream.prototype.write;
        // Make `.write()` always return false, so as to listen `drain` event
        sseStream.write.callsFake(function (...args: any[]) {
          originalWrite.apply(this, args);
          return false;
        });
        sandbox.replace(SseStream.prototype, 'write', sseStream.write);
      });

      afterEach(() => {
        sandbox.restore();
        SseStream.defaultMaxListeners = DEFAULT_MAX_LISTENERS;
      });

      it('should not cause memory leak', async () => {
        let maxDrainListenersExceededWarning = null;
        process.on('warning', (warning: any) => {
          if (
            warning.name === 'MaxListenersExceededWarning' &&
            warning.emitter instanceof SseStream &&
            warning.type === 'drain' &&
            warning.count === MAX_LISTENERS + 1
          ) {
            maxDrainListenersExceededWarning = warning;
          }
        });

        const result = new Subject();

        const response = new Writable();
        response._write = () => {};

        const request = new Writable();
        request._write = () => {};

        routerResponseController.sse(
          result,
          response as unknown as ServerResponse,
          request as unknown as IncomingMessage,
        );

        // Send multiple messages simultaneously
        Array.from({ length: MAX_LISTENERS + 1 }).forEach((_, i) =>
          result.next(String(i)),
        );

        await new Promise(resolve => process.nextTick(resolve));

        expect(maxDrainListenersExceededWarning).to.equal(null);
      });
    });

    describe('when there is an error', () => {
      it('should close the request', done => {
        const result = new Subject();
        const response = new Writable();
        response.end = done as any;
        response._write = () => {};

        const request = new Writable();
        request._write = () => {};

        routerResponseController.sse(
          result,
          response as unknown as ServerResponse,
          request as unknown as IncomingMessage,
        );

        result.error(new Error('Some error'));
      });

      it('should write the error message to the stream', async () => {
        class Sink extends Writable {
          private readonly chunks: string[] = [];

          _write(
            chunk: any,
            encoding: string,
            callback: (error?: Error | null) => void,
          ): void {
            this.chunks.push(chunk);
            callback();
          }

          get content() {
            return this.chunks.join('');
          }
        }

        const written = (stream: Writable) =>
          new Promise((resolve, reject) =>
            stream.on('error', reject).on('finish', resolve),
          );

        const result = new Subject();
        const response = new Sink();
        const request = new PassThrough();
        routerResponseController.sse(
          result,
          response as unknown as ServerResponse,
          request as unknown as IncomingMessage,
        );

        result.error(new Error('Some error'));
        request.destroy();

        await written(response);
        expect(response.content).to.eql(
          `
event: error
id: 1
data: Some error

`,
        );
      });
    });
  });
});
