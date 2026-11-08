import test from 'node:test';
import assert from 'node:assert/strict';
import {readClaudeChromeDebuggingPort} from '../../src/browser/claude-cdp.js';
test('original Chrome numeric port survives a positional startup URL in ps output',()=>{
 const args='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/private/Profile With Spaces --remote-debugging-port=9356 about:blank --proxy-server=socks5://127.0.0.1:1111'.split(/\s+(?=--)/);
 assert.equal(readClaudeChromeDebuggingPort(args),'9356');
 assert.equal(args.find(value=>value.startsWith('--user-data-dir=')),'--user-data-dir=/private/Profile With Spaces');
 assert.equal(readClaudeChromeDebuggingPort(['chrome','--remote-debugging-port=9356','about:blank']),'9356');
 for(const argv of [['--remote-debugging-port=9356evil'],['--remote-debugging-port=9356','--remote-debugging-port=1111'],['--remote-debugging-port='],[]]) assert.equal(readClaudeChromeDebuggingPort(argv),null);
});
