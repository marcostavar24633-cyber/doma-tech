'use strict';
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
const port = 4100 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const rootPromise = fs.mkdtemp(path.join(os.tmpdir(), 'doma-cart-test-'));
let child;
let output = '';
async function start() {
  const root = await rootPromise;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV:'test', PORT:String(port), DATA_DIR:path.join(root,'data'),
      UPLOAD_DIR:path.join(root,'uploads'), SESSION_SECRET:'cart-test-session-secret-at-least-32-characters',
      ADMIN_USERNAME:'cart-admin', ADMIN_PASSWORD:'cart-test-password', ORDER_INTAKE_ENABLED:'true',
      PRIVACY_POLICY_URL:'https://example.invalid/privacy', ORDER_CONSENT_VERSION:'2026-11-15-v1' },
    stdio:['ignore','pipe','pipe']
  });
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  for (let i=0;i<50;i++) {
    if (child.exitCode !== null) throw new Error('Server exited: '+output);
    try { if ((await fetch(base+'/api/health')).ok) return; } catch {}
    await delay(200);
  }
  throw new Error('Server did not start: '+output);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(2500)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
async function req(url, options={}) { return fetch(base+url,{...options,signal:AbortSignal.timeout(5000)}); }
(async()=>{
  try {
    await start();
    const login=await req('/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'cart-admin',password:'cart-test-password'})});
    assert.equal(login.status,200);
    const auth=await login.json();
    const cookie=(login.headers.get('set-cookie')||'').match(/doma\.sid=[^;]+/)?.[0];
    assert.ok(cookie);
    const headers={cookie,'x-csrf-token':auth.csrfToken,'content-type':'application/json'};
    const category=await req('/api/admin/categories',{method:'POST',headers,body:JSON.stringify({name:'Cart test',slug:'cart-test',sort_order:0,description:'test'})});
    assert.equal(category.status,201);
    const createProduct=(name,price)=>req('/api/admin/products',{method:'POST',headers,body:JSON.stringify({name,category:'Cart test',price,description:'Test item'})});
    const created=await createProduct('Dishwasher premium',12500);
    assert.equal(created.status,201);
    const product=await created.json();
    const order=await req('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      name:'Cart customer',contact:'customer@example.invalid',consent:true,consent_version:'2026-11-15-v1',items:[{product_id:product.id,quantity:2,price:1}]
    })});
    assert.equal(order.status,201);
    const orderBody=await order.json();
    assert.equal(orderBody.total,25000,'Server must calculate total from database price, ignoring client price');
    const adminOrders=await req('/api/admin/orders',{headers:{cookie}});
    assert.equal(adminOrders.status,200);
    const saved=(await adminOrders.json()).find(item=>item.id===orderBody.id);
    assert.ok(saved);
    assert.equal(saved.message,'','Cart line items must be stored separately from the customer note');
    assert.equal(saved.consent_version,'2026-11-15-v1');
    assert.ok(saved.consented_at);
    assert.equal(saved.items.length,1,'Admin API must return structured order items');
    assert.equal(saved.items[0].product_name,'Dishwasher premium');
    assert.equal(saved.items[0].unit_price,12500);
    assert.equal(saved.items[0].quantity,2);
    assert.equal(saved.items[0].line_total,25000);
    const invalidQuantity=await req('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      name:'Test',contact:'test@example.invalid',consent:true,consent_version:'2026-11-15-v1',items:[{product_id:product.id,quantity:21}]
    })});
    assert.equal(invalidQuantity.status,400);
    const hidden=await req('/api/admin/products/'+product.id+'/visibility',{method:'PATCH',headers,body:JSON.stringify({active:false})});
    assert.equal(hidden.status,200);
    const hiddenOrder=await req('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      name:'Test',contact:'test@example.invalid',consent:true,consent_version:'2026-11-15-v1',items:[{product_id:product.id,quantity:1}]
    })});
    assert.equal(hiddenOrder.status,409,'Hidden products must not be orderable');
    const unpriced=await createProduct('Unpriced appliance','');
    assert.equal(unpriced.status,201);
    const unpricedProduct=await unpriced.json();
    const unpricedOrder=await req('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      name:'Test',contact:'test@example.invalid',consent:true,consent_version:'2026-11-15-v1',items:[{product_id:unpricedProduct.id,quantity:1}]
    })});
    assert.equal(unpricedOrder.status,409,'Products without a confirmed price must not be orderable');
    console.log('Order cart tests passed');
  } finally { await stop(); }
})().catch(error=>{ console.error(error); process.exitCode=1; });
