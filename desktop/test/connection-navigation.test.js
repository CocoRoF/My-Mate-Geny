'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {isServerLogin,bindConsoleAuthNavigation}=require('../src/connection-navigation');

test('only the connected HTTP origin login route returns to the native chooser',()=>{
 for(const url of ['https://geny.test/login','https://geny.test/login/?error=expired'])assert(isServerLogin(url,'https://geny.test'));
 assert(isServerLogin('https://geny.test/base/login','https://geny.test/base'));
 for(const url of ['https://other.test/login','http://geny.test/login','https://geny.test/login-help','file:///login','https://geny.test/?next=/login'])assert(!isServerLogin(url,'https://geny.test'));
 assert(!isServerLogin('http://127.0.0.1:7000/login','http://127.0.0.1:7001'));
 assert(!isServerLogin('https://geny.test/login',''));
});

test('server redirects, renderer navigation and direct loadURL login pages all recover',()=>{
 const c=new EventEmitter();let hits=0,prevented=0;
 bindConsoleAuthNavigation(c,{serverUrl:()=> 'https://geny.test',onLogin:()=>{hits++;}});
 c.emit('will-navigate',{preventDefault:()=>prevented++},'https://geny.test/login');
 c.emit('will-redirect',{preventDefault:()=>prevented++},'https://geny.test/login',false,true);
 c.emit('did-navigate',{},'https://geny.test/login');
 assert.equal(hits,3);assert.equal(prevented,2);
 c.emit('will-redirect',{preventDefault:()=>assert.fail()},'https://geny.test/login',false,false);
 c.emit('did-navigate',{},'https://other.test/login');assert.equal(hits,3);
});

test('a stale previous-server login cannot sign out the newly selected mode',()=>{
 const c=new EventEmitter();let hits=0,server='https://geny.test';
 bindConsoleAuthNavigation(c,{serverUrl:()=>server,onLogin:()=>{hits++;}});
 server='http://127.0.0.1:7000';c.emit('did-navigate',{},'https://geny.test/login');assert.equal(hits,0);
 c.emit('did-navigate',{},'http://127.0.0.1:7000/login');assert.equal(hits,1);
});

test('a failed chooser transition is reported without an unhandled main-process rejection',async()=>{
 const c=new EventEmitter();let error;
 bindConsoleAuthNavigation(c,{serverUrl:()=> 'https://geny.test',onLogin:async()=>{throw Error('failed');},onError:e=>error=e});
 c.emit('did-navigate',{},'https://geny.test/login');await Promise.resolve();assert.equal(error.message,'failed');
});
