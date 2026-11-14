function notify(message){
  const toast=document.getElementById('toast');
  if(!toast)return;
  toast.textContent=message;
  toast.classList.add('show');
  window.clearTimeout(notify.timer);
  notify.timer=window.setTimeout(()=>toast.classList.remove('show'),4200);
}

const menuButton=document.querySelector('.menu-toggle');
const nav=document.querySelector('.nav');
if(menuButton&&nav){
  menuButton.addEventListener('click',()=>{
    const open=nav.classList.toggle('open');
    menuButton.setAttribute('aria-expanded',String(open));
    menuButton.setAttribute('aria-label',open?'Закрыть меню':'Открыть меню');
  });
  nav.querySelectorAll('a').forEach(link=>link.addEventListener('click',()=>{
    nav.classList.remove('open');
    menuButton.setAttribute('aria-expanded','false');
    menuButton.setAttribute('aria-label','Открыть меню');
  }));
}

document.querySelectorAll('.category-card').forEach(card=>card.addEventListener('click',()=>{
  const finder=document.querySelector('#finderForm');
  if(!finder)return;
  const type=card.dataset.category;
  const typeSelect=finder.querySelector('select[name="type"]');
  const widthSelect=finder.querySelector('select[name="width"]');
  if(typeSelect)typeSelect.value=({
    'built-in':'Встраиваемая',
    'freestanding':'Отдельностоящая',
    'slim':'Пока не определился',
    'compact':'Компактная'
  })[type]||'Пока не определился';
  if(type==='slim'&&widthSelect)widthSelect.value='Около 45 см';
  document.querySelector('#choose')?.scrollIntoView({behavior:'smooth',block:'start'});
  notify('Категория выбрана. Уточните параметры подбора.');
}));

document.getElementById('finderForm')?.addEventListener('submit',event=>{
  event.preventDefault();
  const values=Object.fromEntries(new FormData(event.currentTarget).entries());
  const message=[
    'Подбор техники:',
    'тип — '+values.type,
    'ширина — '+values.width,
    'для кого — '+values.family,
    'бюджет — '+values.budget
  ].join('; ');
  const messageField=document.querySelector('#requestForm textarea[name="message"]');
  if(messageField)messageField.value=message;
  document.querySelector('#request')?.scrollIntoView({behavior:'smooth',block:'start'});
  notify('Параметры подбора перенесены в демонстрационную форму.');
});

document.getElementById('requestForm')?.addEventListener('submit',event=>{
  event.preventDefault();
  notify('Это демонстрационная форма: данные не отправлены и не сохранены.');
});

document.querySelectorAll('.faq details').forEach(item=>item.addEventListener('toggle',()=>{
  const sign=item.querySelector('summary span');
  if(sign)sign.textContent=item.open?'−':'+';
}));


// Локальная фильтрация демонстрационных моделей: без запросов и хранения данных.
(()=>{
 const cards=[...document.querySelectorAll('.market-card')];
 const type=document.getElementById('filterType'),width=document.getElementById('filterWidth'),budget=document.getElementById('filterBudget'),result=document.getElementById('filterResult'),reset=document.getElementById('resetFilters');
 if(!cards.length||!type||!width||!budget||!result||!reset)return;
 const matchesBudget=price=>budget.value==='under30'?price<30000:budget.value==='30to50'?price>=30000&&price<=50000:budget.value==='over50'?price>50000:true;
 const applyFilters=()=>{let visible=0;cards.forEach(card=>{const show=(type.value==='all'||card.dataset.type===type.value)&&(width.value==='all'||card.dataset.width===width.value)&&matchesBudget(Number(card.dataset.price));card.hidden=!show;if(show)visible++;});result.textContent=visible?'Показано моделей: '+visible+' из '+cards.length:'По выбранным параметрам моделей не найдено. Измените фильтры.';};
 [type,width,budget].forEach(control=>control.addEventListener('change',applyFilters));
 reset.addEventListener('click',()=>{type.value='all';width.value='all';budget.value='all';applyFilters();type.focus();});applyFilters();
})();
