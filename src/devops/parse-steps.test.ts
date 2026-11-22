import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeEntities, parseTestSteps } from './client.js';

describe('parseTestSteps text decoding', () => {
  it('turns formatted (HTML) steps into plain text, keeping a typed <placeholder>', () => {
    const xml = '<steps id="0" last="2"><step id="2" type="ActionStep">'
      + '<parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;Select Group: TBC -&amp;nbsp;confirm UK supplier group&lt;/P&gt;&lt;P&gt;Enter &amp;lt;vendor name&amp;gt; &amp;amp; save&lt;/P&gt;&lt;/DIV&gt;</parameterizedString>'
      + '<parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;Saved&lt;BR/&gt;OK&lt;/P&gt;&lt;/DIV&gt;</parameterizedString>'
      + '<description/></step></steps>';
    assert.deepEqual(parseTestSteps(xml), [{ index: 1, action: 'Select Group: TBC - confirm UK supplier group\nEnter <vendor name> & save', expected: 'Saved\nOK' }]);
  });

  it('never strips angle brackets from plain steps', () => {
    const xml = '<steps><step id="2" type="ActionStep"><parameterizedString isformatted="false">Enter &lt;vendor group&gt; if amount &lt; 5</parameterizedString><parameterizedString isformatted="false"></parameterizedString></step></steps>';
    assert.deepEqual(parseTestSteps(xml), [{ index: 1, action: 'Enter <vendor group> if amount < 5', expected: '' }]);
  });

  it('decodes in one pass and leaves unknown entities alone', () => {
    assert.equal(decodeEntities('&amp;lt; &#65;&#x42; &bogus; &nbsp;'), '&lt; AB &bogus;  ');
  });
});
