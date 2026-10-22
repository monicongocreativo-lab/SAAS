import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const {chromium}=createRequire(import.meta.url)('playwright');
const assets=new Map([
  ['/', ['index.html','text/html']], ['/index.html',['index.html','text/html']],
  ['/pilot.css',['pilot.css','text/css']], ['/pilot-app.mjs',['pilot-app.mjs','text/javascript']],
  ['/pilot-model.mjs',['pilot-model.mjs','text/javascript']], ['/favicon.svg',['favicon.svg','image/svg+xml']],
]);
const server=createServer(async(req,res)=>{
  const asset=assets.get(new URL(req.url,'http://localhost').pathname);
  if(!asset){res.writeHead(404);res.end();return;}
  try{res.writeHead(200,{'Content-Type':asset[1]});res.end(await readFile(new URL(`../../dist/${asset[0]}`,import.meta.url)));}
  catch{res.writeHead(500);res.end();}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const url=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.TAMAGO_BROWSER_CHANNEL?{channel:process.env.TAMAGO_BROWSER_CHANNEL}:{})});
  await test('D02 local flow: midnight warning, one collection, persistence, export and close',async()=>{
    const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Tokyo'});
    try{
      const page=await context.newPage();
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.clock.install({time:new Date('2026-10-22T04:59:45Z')});
      await page.goto(url);
      assert.equal(await page.locator('#workDate').inputValue(),'2026-10-21');
      await page.locator('#workspaceMode').selectOption('field');
      await page.locator('[data-action="setup"]').click();
      for(const [name,value] of Object.entries({code:'UI-FICTICIO',name:'Prueba aislada',site:'Sede ficticia',
        initialBirds:'100',startDate:'2026-10-21',openingFeedBags:'5',formula:'Ficticia'})){
        await page.locator(`#setupForm [name="${name}"]`).fill(value);
      }
      await page.locator('#setupForm button[type="submit"], #setupForm .button-primary').click();
      assert.equal(await page.locator('[role="alert"]').filter({hasText:'Sin información de recogidas'}).count(),0);
      await page.clock.runFor(30000);
      await page.locator('[role="alert"]').filter({hasText:'Sin información de recogidas'}).waitFor();
      await page.locator('[data-view="overview"]').click();
      assert.equal(await page.locator('.kpi-card').filter({hasText:'Huevos recogidos'}).locator('.kpi-value').innerText(),'—');
      assert.equal(await page.locator('.mini-metric').filter({hasText:'Postura observada'}).locator('strong').innerText(),'— %');
      await page.locator('[data-view="day"]').click();
      await page.locator('[data-action="collection"][data-turn="1"]').click();
      await page.locator('#eventForm [name="quantity"]').fill('10');
      await page.locator('#eventForm .button-primary').click();
      assert.equal(await page.locator('[role="alert"]').filter({hasText:'Sin información de recogidas'}).count(),0);
      assert.equal(await page.locator('#pendingBadge').innerText(),'3');
      assert.match(await page.locator('#screen').innerText(),/Una o dos recogidas son válidas/);
      const saved=await page.evaluate(()=>localStorage.getItem('tamago:pilot:v1:field'));
      const demoBefore=await page.evaluate(()=>localStorage.getItem('tamago:pilot:v1:demo'));
      assert.equal(JSON.parse(saved).events.length,1);
      await page.reload();
      await page.locator('#workspaceMode').selectOption('field');
      await page.locator('#workDate').fill('2026-10-21');
      await page.locator('#workDate').dispatchEvent('change');
      assert.equal(await page.locator('.kpi-card').filter({hasText:'Huevos recogidos'}).locator('.kpi-value').innerText(),'10');
      assert.equal(await page.evaluate(()=>localStorage.getItem('tamago:pilot:v1:field')),saved);
      const downloadEvent=page.waitForEvent('download');
      await page.locator('[data-action="export"]').click();
      const exported=JSON.parse(await readFile(await(await downloadEvent).path(),'utf8'));
      assert.deepEqual(exported.state,JSON.parse(saved));assert.equal(exported.localOnly,true);
      await page.locator('#workspaceMode').selectOption('demo');
      assert.equal(await page.locator('#lotLabel').innerText(),'DEMO-01');
      assert.equal(await page.evaluate(()=>localStorage.getItem('tamago:pilot:v1:field')),saved);
      assert.equal(await page.evaluate(()=>localStorage.getItem('tamago:pilot:v1:demo')),demoBefore);
      await page.locator('#workspaceMode').selectOption('field');
      await page.locator('[data-view="day"]').click();
      for(const [type,name,value] of [['classification','AA','10'],['supply','bags','0'],['mortality','quantity','0']]){
        await page.locator(`[data-action="${type}"]`).click();
        await page.locator(`#eventForm [name="${name}"]`).fill(value);
        if(type==='classification')await page.locator('#eventForm input[type="checkbox"]').check();
        await page.locator('#eventForm .button-primary').click();
        assert.equal(await page.locator('#recordDialog').evaluate(el=>el.open),false);
      }
      await page.screenshot({path:'/private/tmp/tamago-dev001-desktop.png',fullPage:true});
      await page.locator('[data-action="close"]').click();
      await page.locator('#eventForm [name="closedBy"]').fill('Revisor ficticio');
      await page.locator('#eventForm .button-primary').click();
      assert.match(await page.locator('.close-panel').innerText(),/Jornada cerrada/);
      const closed=await page.evaluate(()=>JSON.parse(localStorage.getItem('tamago:pilot:v1:field')));
      assert.equal(closed.events.filter(e=>e.type==='collection').length,1);
      assert.equal(closed.events.length,5);
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      await page.screenshot({path:'/private/tmp/tamago-dev001-mobile.png',fullPage:true});
      await page.reload();await page.locator('#workspaceMode').selectOption('field');
      await page.locator('#workDate').fill('2026-10-21');await page.locator('#workDate').dispatchEvent('change');
      await page.locator('[data-view="day"]').click();
      assert.match(await page.locator('.close-panel').innerText(),/Jornada cerrada/);
      assert.deepEqual(errors,[]);
    }finally{await context.close();}
  });
  await test('existing v1 closed snapshot is read unchanged, without rewriting storage',async()=>{
    const fixture={schemaVersion:1,mode:'field',selectedLotId:'legacy-lot',lots:[{
      id:'legacy-lot',code:'LEGACY-FICTICIO',name:'Datos ficticios v1',site:'Sede ficticia',company:'Tamago',
      initialBirds:100,startDate:'2026-10-18',formula:'Ficticia',openingFeedBags:5,
    }],events:[]};
    const add=(type,payload)=>fixture.events.push({id:`legacy-${fixture.events.length}`,type,
      lotId:'legacy-lot',businessDate:'2026-10-18',payload,recordedAt:'2026-10-18T20:00:00Z'});
    for(const turn of [1,2,3])add('collection',{turn,quantity:10});
    add('classification',{quantities:{AA:30},dirty:0,lost:0});add('supply',{bags:0});
    add('mortality',{quantity:0});add('close',{closedBy:'Revisor ficticio v1'});
    const raw=JSON.stringify(fixture);
    const context=await browser.newContext();
    try{
      await context.addInitScript(raw=>{if(!localStorage.getItem('tamago:pilot:v1:field'))localStorage.setItem('tamago:pilot:v1:field',raw);},raw);
      const page=await context.newPage();await page.goto(url);
      await page.locator('#workspaceMode').selectOption('field');
      await page.locator('#workDate').fill('2026-10-18');await page.locator('#workDate').dispatchEvent('change');
      await page.locator('[data-view="day"]').click();
      assert.equal(await page.locator('#storageWarning').isVisible(),false);
      assert.match(await page.locator('.close-panel').innerText(),/Revisor ficticio v1/);
      assert.equal(await page.evaluate(()=>localStorage.getItem('tamago:pilot:v1:field')),raw);
    }finally{await context.close();}
  });
}finally{
  await browser?.close();await new Promise(resolve=>server.close(resolve));
}
