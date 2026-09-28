import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSite, siteForJob } from '../extension/lib/sites.mjs';
import { enqueueKeyword, retryJob } from '../extension/lib/core.mjs';

test('a 1688 address stays on 1688 and a Pinduoduo address stays on Pinduoduo', () => {
  const ali = resolveSite('https://www.1688.com/');
  assert.equal(ali.supported, true);
  assert.equal(ali.id, '1688');
  assert.equal(ali.label, '1688');
  assert.equal(ali.searchUrl('玉石手电筒'), 'https://s.1688.com/selloffer/offer_search.htm?keywords=%D3%F1%CA%AF%CA%D6%B5%E7%CD%B2');
  assert.equal(ali.isSearch(ali.searchUrl('棉布 窗帘'), '棉布 窗帘'), true);
  assert.equal(ali.productUrl('5566'), 'https://detail.1688.com/offer/5566.html');
  assert.equal(ali.productId('https://detail.1688.com/offer/5566.html'), '5566');
  assert.equal(ali.isSearch(ali.searchUrl('棉布'), '棉布'), true);
  assert.equal(ali.isSearch('https://s.1688.com/selloffer/offer_search.htm?keywords=其他', '棉布'), false);

  const pdd = resolveSite('https://mobile.yangkeduo.com/');
  assert.equal(pdd.id, 'pdd');
  assert.equal(pdd.label, '拼多多');
  assert.equal(pdd.searchUrl('相机').includes('search_key='), true);
  assert.equal(resolveSite('https://mobile.pinduoduo.com/').id, 'pdd');
});

test('unknown and insecure addresses are rejected', () => {
  assert.equal(resolveSite(''), null);
  assert.equal(resolveSite('http://www.1688.com/'), null);
  assert.equal(resolveSite('https://example.com/search').supported, false);
  assert.equal(resolveSite('https://1688.com.attacker.example/').supported, false);
  assert.equal(resolveSite('javascript:alert(1)'), null);
});

test('a missing site stays on Pinduoduo and a retried name keeps its original site', () => {
  assert.equal(siteForJob({}).id, 'pdd');
  assert.equal(siteForJob({ site: '1688' }).searchUrl('书包').includes('1688.com'), true);
  const task = enqueueKeyword(null, '相机', '1688');
  assert.equal(task.jobs[0].site, '1688');
  enqueueKeyword(task, '书包');
  assert.equal(task.jobs[1].site, 'pdd');
  task.jobs[0].status = 'done';
  retryJob(task, 0);
  assert.equal(task.jobs[0].site, '1688');
  assert.equal(task.jobs[0].status, 'pending');
});
