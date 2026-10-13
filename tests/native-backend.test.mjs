import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBackendBroker, handleBackendMessage } from '../extension/lib/native-backend.mjs';

const code = 'http://127.0.0.1:53121/#token=fixture';
function fixture() {
  const ports = [], timers = new Map(); let serial = 0;
  const event = () => ({ listeners:[], addListener(fn) { this.listeners.push(fn); }, emit(value) { for (const fn of this.listeners) fn(value); } });
  const runtime = { id:'a'.repeat(32), getURL:path=>`chrome-extension://${'a'.repeat(32)}/${path}`, connectNative(host) {
    assert.equal(host,'com.productcollector.images');
    const port = { onMessage:event(), onDisconnect:event(), sent:[], postMessage(value) { this.sent.push(value); }, disconnect() { this.onDisconnect.emit(); } };
    ports.push(port); return port;
  } };
  const broker = new NativeBackendBroker({ runtime, setTimer:(fn,ms)=>{timers.set(++serial,{fn,ms});return serial;}, clearTimer:id=>timers.delete(id) });
  const reply = (port=ports.at(-1), value={ok:true,version:'1.6.6',connection_code:code}) => port.onMessage.emit({id:port.sent.at(-1).id,...value});
  return {runtime,broker,ports,timers,reply};
}
test('concurrent managers share one connect and retained native port pings within the lease window',async()=>{
  const f=fixture(), first=f.broker.ensureBackend(),second=f.broker.ensureBackend();
  assert.equal(f.ports.length,1);assert.equal(f.ports[0].sent.length,1);
  assert.deepEqual(Object.keys(f.ports[0].sent[0]).sort(),['action','id']);
  f.reply();assert.equal(await first,code);assert.equal(await second,code);
  assert.equal(await f.broker.ensureBackend(),code);
  const heartbeat=[...f.timers.values()].find(t=>t.ms<=20000);assert.ok(heartbeat);heartbeat.fn();
  assert.equal(f.ports[0].sent.at(-1).action,'ping');f.reply(undefined,{ok:true,version:'1.6.6'});
  assert.equal(await f.broker.ensureBackend(),code);
});
test('dropped native port rejects pending requests and reconnects on demand',async()=>{
  const f=fixture(),pending=f.broker.ensureBackend();f.ports[0].onDisconnect.emit();
  await assert.rejects(pending,/后台|安装/);const next=f.broker.ensureBackend();assert.equal(f.ports.length,2);f.reply();assert.equal(await next,code);
});
test('malformed, unsupported, and non-loopback native replies never become backend connections',async()=>{
  for(const value of [{ok:true,version:'1.6.6',connection_code:'https://evil.test/#token=secret'},{ok:true,version:'1.6.5',connection_code:code},{ok:true,version:'1.6.6'}, {ok:false,error:'http://secret.test/credential'}]) {
    const f=fixture(),pending=f.broker.ensureBackend();f.reply(undefined,value);
    await assert.rejects(pending,/后台|升级|安装/);assert.equal(f.broker.connectionCode,null);
  }
});
test('missing native host and request timeout have safe installation guidance',async()=>{
  const f=fixture();f.runtime.connectNative=()=>{throw new Error('private system path');};
  await assert.rejects(f.broker.ensureBackend(),error=>/安装/.test(error.message)&&!error.message.includes('private'));
  const g=fixture(),pending=g.broker.ensureBackend();[...g.timers.values()][0].fn();await assert.rejects(pending,/后台|安装/);
});
test('only the same extension manager page can obtain ephemeral backend credentials',async()=>{
  const f=fixture(),good={id:f.runtime.id,url:f.runtime.getURL('manager.html')};
  for(const sender of [{...good,url:f.runtime.getURL('other.html')},{...good,url:'https://example.test/manager.html'},{...good,id:'b'.repeat(32)},{...good,url:good.url+'?fake=1'}]) {
    const result=await handleBackendMessage({type:'ensure-backend'},sender,f.broker,f.runtime);assert.equal(result.ok,false);assert.equal(f.ports.length,0);
  }
  const pending=handleBackendMessage({type:'ensure-backend'},good,f.broker,f.runtime);f.reply();assert.deepEqual(await pending,{ok:true,connection_code:code});
});
test('connection reply followed by immediate native disconnect cannot cache a dead backend',async()=>{
  const f=fixture(),pending=f.broker.ensureBackend();f.reply();f.ports[0].onDisconnect.emit();
  await assert.rejects(pending,/后台|安装/);assert.equal(f.broker.connectionCode,null);
});
test('native startup may use its full twenty-second discovery window before broker times out',async()=>{
  const f=fixture(),pending=f.broker.ensureBackend();
  for(const timer of [...f.timers.values()].filter(timer=>timer.ms<=20000))timer.fn();
  f.reply();assert.equal(await pending,code);
});
test('heartbeat schedules its next twenty-second send while the native reply is pending',async()=>{
  const f=fixture(),pending=f.broker.ensureBackend();f.reply();await pending;
  const [id,heartbeat]=[...f.timers].find(([,timer])=>timer.ms===20000);f.timers.delete(id);heartbeat.fn();
  assert.equal(f.ports[0].sent.at(-1).action,'ping');
  assert.ok([...f.timers.values()].some(timer=>timer.ms===20000),'next send is scheduled before the current reply');
  f.reply(undefined,{ok:true,version:'1.6.6'});
});
