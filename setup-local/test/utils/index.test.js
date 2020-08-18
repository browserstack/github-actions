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
    it('Returns true if tool exists in cache', () => {
      sinon.stub(tc, 'findAllVersions').returns(['somePath']);
      expect(Utils.checkToolInCache('someTool')).to.eq(true);
      sinon.assert.calledWith(tc.findAllVersions, 'someTool');
      tc.findAllVersions.restore();
    });

    it("Returns false if tool doesn't exists in cache", () => {
      sinon.stub(tc, 'findAllVersions').returns([]);
      expect(Utils.checkToolInCache('someTool')).to.eq(false);
      sinon.assert.calledWith(tc.findAllVersions, 'someTool');
      tc.findAllVersions.restore();
    });
  });
});
