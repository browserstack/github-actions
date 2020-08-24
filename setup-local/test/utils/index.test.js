const { expect } = require("chai");
const sinon = require("sinon");
const core = require('@actions/core');
const tc = require('@actions/tool-cache');
const Utils = require("../../src/utils");

describe('Utils', () => {
  context('Clear Environment Variables', () => {
    it('Sets empty string as the value and deletes the entry from process.env', () => {
      sinon.stub(core, 'exportVariable');
      process.env.someVariable = 'someValue';
      Utils.clearEnvironmentVariable('someVariable');
      sinon.assert.calledWith(core.exportVariable, 'someVariable', '');
      expect(process.env.someVariable).to.eq(undefined);
      core.exportVariable.restore();
    });
  });

  context('Check if tool exists in cache', () => {
    it('Returns the path if tool exists in cache', () => {
      sinon.stub(tc, 'find').returns('some/path');
      expect(Utils.checkToolInCache('someTool', 'version')).to.eq('some/path');
      sinon.assert.calledWith(tc.find, 'someTool', 'version');
      tc.find.restore();
    });

    it("Returns empty string if tool doesn't exists in cache", () => {
      sinon.stub(tc, 'find').returns('');
      expect(Utils.checkToolInCache('someTool', 'version')).to.eq('');
      sinon.assert.calledWith(tc.find, 'someTool', 'version');
      tc.find.restore();
    });
  });

  context('SleepFor', () => {
    it('Sleeps for given milliseconds', (done) => {
      const fakeTimer = sinon.useFakeTimers();
      const startTime = Date.now();
      Utils.sleepFor(5000)
        .then(() => {
          expect(Date.now() - startTime).to.eq(5000);
          fakeTimer.restore();
          done();
        });
      fakeTimer.tick(5000);
    });

    it('Sleeps for 0 milliseconds if the value is NaN', (done) => {
      const fakeTimer = sinon.useFakeTimers();
      const startTime = Date.now();
      Utils.sleepFor("Not a Number")
        .then(() => {
          expect(Date.now() - startTime).to.eq(0);
          fakeTimer.restore();
          done();
        });
      fakeTimer.tick(0);
    });

    it('Sleeps for 0 milliseconds if the value is <= 0', (done) => {
      const fakeTimer = sinon.useFakeTimers();
      const startTime = Date.now();
      Utils.sleepFor(-10)
        .then(() => {
          expect(Date.now() - startTime).to.eq(0);
          fakeTimer.restore();
          done();
        });
      fakeTimer.tick(0);
    });
  });
});
