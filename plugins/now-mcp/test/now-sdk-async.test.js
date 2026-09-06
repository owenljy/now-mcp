import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,delimiter} from 'node:path';
import {tmpdir} from 'node:os';

test('SDK probes are single-flight and explicit asynchronous fallback preserves safe diagnostics',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'now-sdk-async-'));const counter=join(dir,'calls');
  const previous=process.env.PATH;
  const authList='[old]\n host = https://dev\n type = basic\n default = No\n[valid]\n host = https://dev\n type = basic\n default = No';
  writeFileSync(join(dir,'now-sdk'),`#!${process.execPath}\nimport('node:fs').then(fs=>{
    const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(counter)},args[0]+'\\n');
    setTimeout(()=>{
      if(args[0]==='--version')console.log('4.9.0');
      else if(args[0]==='auth')console.log(${JSON.stringify(authList)});
      else if(args[args.indexOf('--auth')+1]==='old'){
        console.log(JSON.stringify({ok:false,error:'User name or password invalid: SHOULD_NOT_LEAK'}));process.exitCode=1;
      }else console.log(JSON.stringify({ok:true,records:[{sys_id:'test'}],hasMore:false,nextOffset:null}));
    },60);
  });`,{mode:0o700});
  process.env.PATH=dir+delimiter+previous;
  try{
    const sdk=await import('../build/utils/now-sdk-cli.js?async-test');
    let tick=false;const timer=setTimeout(()=>{tick=true;},10);
    const versions=await Promise.all([sdk.getNowSdkVersion(),sdk.getNowSdkVersion()]);clearTimeout(timer);
    assert.equal(tick,true);assert.deepEqual(versions,['4.9.0','4.9.0']);
    const lists=await Promise.all([sdk.listNowSdkProfiles(),sdk.listNowSdkProfiles()]);assert.equal(lists[0].length,2);
    assert.deepEqual(readFileSync(counter,'utf8').trim().split('\n'),['--version','auth']);
    const ambiguous=await sdk.queryNowSdkWithAlignedProfile('https://dev','incident');
    assert.equal(ambiguous.ok,false);assert.match(ambiguous.reason,/multiple/);
    assert.equal(readFileSync(counter,'utf8').includes('query'),false,'ambiguity never tries identities');
    const failed=await sdk.queryNowSdkWithAlignedProfile('https://dev','incident',{authProfile:'old'});
    assert.match(failed.reason,/authentication failed/);assert.ok(!failed.reason.includes('SHOULD_NOT_LEAK'));
    const good=await sdk.queryNowSdkWithAlignedProfile('https://dev','incident',{authProfile:'valid'});
    assert.equal(good.ok,true);assert.equal(good.profile,'valid');assert.equal(good.records.length,1);
  }finally{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;rmSync(dir,{recursive:true,force:true});}
});
