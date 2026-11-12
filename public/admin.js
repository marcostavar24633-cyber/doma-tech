let csrfToken='';
const $=s=>document.querySelector(s);
async function request(url,opts={}){
 const headers={...(opts.headers||{})};
 if(csrfToken && opts.method && opts.method!=='GET')headers['x-csrf-token']=csrfToken;
 const res=await fetch(url,{credentials:'same-origin',...opts,headers});
 const data=await res.json().catch(()=>({}));
 if(!res.ok)throw new Error(data.error||'Ошибка запроса');
 return data;
}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function showDashboard(user){$('#loginPanel').hidden=true;$('#dashboard').hidden=false;$('#adminName').textContent=user;}
function showLogin(){$('#loginPanel').hidden=false;$('#dashboard').hidden=true;}
function resetProductForm(){const f=$('#productForm');f.reset();f.elements.id.value='';f.dataset.image='';$('#formTitle').textContent='Добавить товар';}
async function checkSession(){
 try{const me=await request('/api/admin/me');csrfToken=me.csrfToken;showDashboard(me.username);await loadProducts();await loadOrders();}
 catch(e){showLogin();}
}
$('#loginForm').addEventListener('submit',async e=>{
 e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget).entries());
 try{const result=await request('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});csrfToken=result.csrfToken;$('#loginError').textContent='';showDashboard(result.username);await loadProducts();await loadOrders();}
 catch(err){$('#loginError').textContent=err.message;}
});
$('#logoutBtn').addEventListener('click',async()=>{try{await request('/api/admin/logout',{method:'POST'});}catch(e){}csrfToken='';showLogin();});
document.querySelectorAll('.admin-tab').forEach(btn=>btn.addEventListener('click',()=>{
 document.querySelectorAll('.admin-tab').forEach(x=>x.classList.toggle('active',x===btn));
 $('#productsTab').hidden=btn.dataset.tab!=='products';$('#ordersTab').hidden=btn.dataset.tab!=='orders';
}));
async function loadProducts(){
 const items=await request('/api/admin/products');$('#productCount').textContent=`(${items.length})`;
 $('#productList').innerHTML=items.length?items.map(p=>`<article class="admin-product"><div class="admin-prod-main">${p.image?`<img class="admin-preview" src="${esc(p.image)}" alt="">`:'<span class="admin-preview-placeholder">▧</span>'}<div><strong>${esc(p.name)}</strong><small>${esc(p.category)} · ${p.price!==null?Number(p.price).toLocaleString('ru-RU')+' ₽':'Цена не указана'}</small><small>${esc(p.description)}</small></div></div><div class="admin-actions"><button class="admin-button light" data-edit="${p.id}">Изменить</button><button class="admin-button light" data-delete="${p.id}">Удалить</button></div></article>`).join(''):'<div class="admin-empty">Товаров пока нет. Добавьте первый товар.</div>';
}
$('#productForm').addEventListener('submit',async e=>{
 e.preventDefault();const f=e.currentTarget;const fd=new FormData(f);let image=fd.get('image')||f.dataset.image||'';
 const file=f.elements.imageFile.files[0];
 try{
  if(file){const up=new FormData();up.append('image',file);const result=await request('/api/admin/upload',{method:'POST',body:up});image=result.url;}
  const body={name:fd.get('name'),category:fd.get('category'),price:fd.get('price'),description:fd.get('description'),image};
  const id=fd.get('id');
  await request(id?`/api/admin/products/${id}`:'/api/admin/products',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  $('#productStatus').textContent='Товар сохранён в серверной базе данных.';resetProductForm();await loadProducts();
 }catch(err){$('#productStatus').textContent=err.message;}
});
$('#clearBtn').addEventListener('click',()=>setTimeout(resetProductForm,0));
$('#productList').addEventListener('click',async e=>{
 const edit=e.target.closest('[data-edit]'),del=e.target.closest('[data-delete]');
 if(edit){try{const items=await request('/api/admin/products');const p=items.find(x=>x.id===Number(edit.dataset.edit));if(!p)return;const f=$('#productForm');for(const k of ['id','name','category','price','description','image'])f.elements[k].value=p[k]??'';f.dataset.image=p.image||'';$('#formTitle').textContent='Редактировать товар';window.scrollTo({top:0,behavior:'smooth'});}catch(err){alert(err.message)}}
 if(del&&confirm('Удалить товар из каталога?')){try{await request('/api/admin/products/'+del.dataset.delete,{method:'DELETE'});await loadProducts();}catch(err){alert(err.message)}}
});
async function loadOrders(){
 const items=await request('/api/admin/orders');$('#orderCount').textContent=items.length?`(${items.length})`:'';
 $('#ordersList').innerHTML=items.length?items.map(o=>`<article class="admin-order"><div><strong>#${o.id} · ${esc(o.name)}</strong><small>${esc(o.contact)} · ${esc(o.created_at)}</small><p>${esc(o.message)}</p></div><div class="order-control"><select data-status="${o.id}"><option value="new" ${o.status==='new'?'selected':''}>Новая</option><option value="in_progress" ${o.status==='in_progress'?'selected':''}>В работе</option><option value="completed" ${o.status==='completed'?'selected':''}>Завершена</option><option value="cancelled" ${o.status==='cancelled'?'selected':''}>Отменена</option></select></div></article>`).join(''):'<div class="admin-empty">Заявок пока нет.</div>';
}
$('#ordersList').addEventListener('change',async e=>{
 const id=e.target.dataset.status;if(!id)return;
 try{await request('/api/admin/orders/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:e.target.value})});}
 catch(err){alert(err.message);await loadOrders();}
});
checkSession();
