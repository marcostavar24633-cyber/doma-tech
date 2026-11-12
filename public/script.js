async function api(url, options={}) {
  const res=await fetch(url,{credentials:'same-origin',...options});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||'Ошибка запроса');
  return data;
}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
const toast=document.getElementById('toast');
function notify(message){toast.textContent=message;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),4500);}
async function loadProducts(){
 const grid=document.getElementById('productGrid'); if(!grid)return;
 try{
  const products=await api('/api/products');
  if(!products.length)return;
  grid.innerHTML=products.map(p=>`<article class="product-placeholder"><div class="product-visual">${p.image?`<img class="catalog-product-image" src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">`:`<div class="appliance appliance-built"><i></i><b></b></div>`}<span>${esc(p.category)}</span></div><div class="product-info"><small>${esc(p.category.toUpperCase())}</small><h3>${esc(p.name)}</h3><p>${esc(p.description||'Характеристики уточняются.')}</p><b class="price">${p.price!==null?Number(p.price).toLocaleString('ru-RU')+' ₽':'Цена по запросу'}</b></div></article>`).join('');
 }catch(e){console.error(e);}
}
const menuButton=document.querySelector('.menu-toggle'),nav=document.querySelector('.nav');
if(menuButton&&nav){menuButton.addEventListener('click',()=>{const open=nav.classList.toggle('open');menuButton.setAttribute('aria-expanded',String(open));});nav.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{nav.classList.remove('open');menuButton.setAttribute('aria-expanded','false');}));}
document.querySelectorAll('.category-card').forEach(card=>card.addEventListener('click',()=>{
 document.querySelector('#choose').scrollIntoView({behavior:'smooth'});
 const type=card.dataset.category,select=document.querySelector('#finderForm select[name="type"]');
 select.value=({'built-in':'Встраиваемая','freestanding':'Отдельностоящая','slim':'Встраиваемая','compact':'Компактная'})[type]||'Пока не определился';
 if(type==='slim')document.querySelector('#finderForm select[name="width"]').value='Около 45 см';
 notify('Категория выбрана. Уточните параметры подбора.');
}));
document.getElementById('finderForm')?.addEventListener('submit',e=>{
 e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget).entries());
 const message=`Подбор техники: тип — ${d.type}; ширина — ${d.width}; для кого — ${d.family}; бюджет — ${d.budget}`;
 document.querySelector('#requestForm textarea[name="message"]').value=message;
 document.querySelector('#request').scrollIntoView({behavior:'smooth'});
 notify('Параметры перенесены в форму заявки. Укажите контакты.');
});
document.getElementById('requestForm')?.addEventListener('submit',async e=>{
 e.preventDefault();const form=e.currentTarget;const data=Object.fromEntries(new FormData(form).entries());
 try{await api('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});form.reset();notify('Спасибо! Заявка принята. Менеджер сможет связаться с вами.');}
 catch(err){notify(err.message);}
});
document.querySelectorAll('.faq details').forEach(item=>item.addEventListener('toggle',()=>{const sign=item.querySelector('summary span');if(sign)sign.textContent=item.open?'−':'+';}));
loadProducts();
