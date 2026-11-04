import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { PassThrough } from "node:stream";
import { loginCodexManually, CODEX_MANUAL_REDIRECT } from "../../src/credentials/codex-manual-login.js";
import { createManualCallbackStdioProtocol } from "../../src/cli/manual-callback-stdio.js";

const jwt = accountId => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({exp:4102444800,"https://api.openai.com/auth":{chatgpt_account_id:accountId}})).toString("base64url")}.SYNTHETIC`;
const tokenResponse=()=>({ok:true,status:200,json:async()=>({access_token:jwt("fixture-account"),id_token:jwt("fixture-account"),refresh_token:"SYNTHETIC_REFRESH",expires_in:3600})});
function flow(options={}) {
  let accept, reject;
  const input=new Promise((resolve,fail)=>{accept=resolve;reject=fail;});
  const calls=[];
  const promise=loginCodexManually({
    readCallbackUrl:()=>input,
    emitAuthUrl:({url})=>{
      const auth=new URL(url), callback=new URL(CODEX_MANUAL_REDIRECT);
      callback.search=new URLSearchParams({code:"SYNTHETIC_CODE",state:auth.searchParams.get("state")});
      if(options.reject) reject(new Error("stdin closed"));
      else if(!options.pending) accept(options.edit ? options.edit(callback,auth) : callback.href);
      options.observe?.(auth);
    },
    fetchJsonWithTimeoutImpl:async(...args)=>{calls.push(args);return options.response?.()??tokenResponse();},
    expectedAccountId:options.accountId??"fixture-account",timeoutMs:1000,...options.login,
  });
  return {promise,calls};
}

test("manual PKCE succeeds with the callback port occupied and performs one bounded exchange",async t=>{
  let httpRequests=0,auth;
  const listener=http.createServer((req,res)=>{httpRequests++;res.end("unrelated listener");});
  await new Promise((resolve,reject)=>{listener.once("error",reject);listener.listen(1455,"127.0.0.1",resolve);});
  t.after(()=>new Promise(resolve=>listener.close(resolve)));
  const {promise,calls}=flow({observe:url=>{auth=url;}});
  assert.equal((await promise).accountId,"fixture-account");
  assert.equal(httpRequests,0);
  assert.equal(calls.length,1);
  const [url,request,timeout]=calls[0];
  assert.equal(url,"https://auth.openai.com/oauth/token");
  assert.equal(request.redirect,"error");
  assert.equal(timeout,8000);
  assert.equal(request.body.get("redirect_uri"),CODEX_MANUAL_REDIRECT);
  assert.equal(createHash("sha256").update(request.body.get("code_verifier")).digest("base64url"),auth.searchParams.get("code_challenge"));
});

for(const [name,edit] of [
  ["wrong state",u=>{u.searchParams.set("state","wrong");return u.href;}],
  ["duplicate state",u=>{u.searchParams.append("state","wrong");return u.href;}],
  ["duplicate code",u=>{u.searchParams.append("code","second");return u.href;}],
  ["missing code",u=>{u.searchParams.delete("code");return u.href;}],
  ["missing state",u=>{u.searchParams.delete("state");return u.href;}],
  ["wrong redirect",u=>{u.hostname="elsewhere.invalid";return u.href;}],
  ["OAuth error",u=>{u.searchParams.set("error","access_denied");return u.href;}],
  ["bare code",()=>"SYNTHETIC_CODE"],
]) test(`manual callback rejects ${name} before exchanging`,async()=>{
  const {promise,calls}=flow({edit});
  await assert.rejects(promise);
  assert.equal(calls.length,0);
});

test("EOF, cancellation and timeout cannot trigger an alternate login",async()=>{
  for(const options of [{reject:true},{pending:true,login:{timeoutMs:10}},{pending:true,login:{signal:AbortSignal.abort()}}]) {
    const {promise,calls}=flow(options);
    await assert.rejects(promise);
    assert.equal(calls.length,0);
  }
});

test("failed or foreign token responses do not return credentials or replay the code",async()=>{
  for(const options of [{accountId:"another-account"},{response:()=>({ok:false,status:400,json:async()=>({error:"invalid_grant",detail:"PRIVATE_RESPONSE"})})}]) {
    const {promise,calls}=flow(options);
    await assert.rejects(promise,error=>!error.message.includes("PRIVATE_RESPONSE"));
    assert.equal(calls.length,1);
  }
});

test("an unfinished URL handoff remains cancellable",async()=>{
  let requested=false;
  await assert.rejects(loginCodexManually({
    emitAuthUrl:()=>new Promise(()=>{}),readCallbackUrl:()=>new Promise(()=>{}),timeoutMs:10,
    fetchJsonWithTimeoutImpl:async()=>{requested=true;return tokenResponse();},
  }),/cancelled or timed out/);
  assert.equal(requested,false);
});

test("cancellation during exchange never returns a credential",async()=>{
  const controller=new AbortController();
  const {promise,calls}=flow({login:{signal:controller.signal},response:()=>{
    controller.abort();return tokenResponse();
  }});
  await assert.rejects(promise);
  assert.equal(calls.length,1);
});

test("the existing JSONL manual protocol accepts raw and JSON callback inputs",async()=>{
  for(const encoding of [url=>url,url=>JSON.stringify({url}),url=>JSON.stringify({callbackUrl:url})]) {
    const stdin=new PassThrough(),stdout=new PassThrough();
    const protocol=createManualCallbackStdioProtocol({stdin,stdout,label:"fixture",provider:"openai-codex"});
    stdout.once("data",chunk=>{
      const event=JSON.parse(chunk.toString()),auth=new URL(event.url),callback=new URL(CODEX_MANUAL_REDIRECT);
      assert.equal(event.type,"auth_url");
      callback.search=new URLSearchParams({code:"SYNTHETIC_CODE",state:auth.searchParams.get("state")});
      stdin.end(encoding(callback.href)+"\n");
    });
    assert.equal((await loginCodexManually({...protocol,fetchJsonWithTimeoutImpl:async()=>tokenResponse()})).accountId,"fixture-account");
    stdin.destroy();stdout.destroy();
  }
});
