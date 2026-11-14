function notify(message){
  const toast=document.getElementById('toast');
  if(!toast)return;
  toast.textContent=message;
  toast.classList.add('show');
  window.clearTimeout(notify.timer);
  notify.timer=window.setTimeout(()=>toast.classList.remove('show'),4200);
}

function scrollToTarget(target){
  if(!target)return;
  const reduceMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({behavior:reduceMotion?'auto':'smooth',block:'start'});
}

const menuButton=document.querySelector('.menu-toggle');
const nav=document.querySelector('.nav');
if(menuButton&&nav){
  const closeMenu=({returnFocus=false}={})=>{
    nav.classList.remove('open');
    menuButton.setAttribute('aria-expanded','false');
    menuButton.setAttribute('aria-label','Открыть меню');
    if(returnFocus)menuButton.focus();
  };
  menuButton.addEventListener('click',()=>{
    const open=menuButton.getAttribute('aria-expanded')!=='true';
    nav.classList.toggle('open',open);
    menuButton.setAttribute('aria-expanded',String(open));
    menuButton.setAttribute('aria-label',open?'Закрыть меню':'Открыть меню');
  });
  nav.querySelectorAll('a').forEach(link=>link.addEventListener('click',()=>closeMenu()));
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&nav.classList.contains('open'))closeMenu({returnFocus:true});
  });
  document.addEventListener('click',event=>{
    if(nav.classList.contains('open')&&!nav.contains(event.target)&&!menuButton.contains(event.target))closeMenu();
  });
}

document.querySelectorAll('.category-card').forEach(card=>card.addEventListener('click',()=>{
  const finder=document.querySelector('#finderForm');
  if(!finder)return;
  const type=card.dataset.category;
  const typeSelect=finder.querySelector('select[name="type"]');
  const widthSelect=finder.querySelector('select[name="width"]');
  const typeValues={
    'built-in':'Встраиваемая',
    'freestanding':'Отдельностоящая',
    'slim':'Пока не определился',
    'compact':'Компактная'
  };
  if(typeSelect)typeSelect.value=typeValues[type]||'Пока не определился';
  if(widthSelect){
    widthSelect.value=type==='slim'?'Около 45 см':type==='compact'?'Нужна компактная модель':'Пока не знаю';
  }
  scrollToTarget(document.querySelector('#choose'));
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
  scrollToTarget(document.querySelector('#request'));
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
  const type=document.getElementById('filterType');
  const width=document.getElementById('filterWidth');
  const budget=document.getElementById('filterBudget');
  const sort=document.getElementById('sortModels');
  const result=document.getElementById('filterResult');
  const reset=document.getElementById('resetFilters');
  if(!cards.length||!type||!width||!budget||!sort||!result||!reset)return;
  const grid=cards[0].parentElement;
  const matchesBudget=price=>budget.value==='under30'?price<30000:budget.value==='30to50'?price>=30000&&price<=50000:budget.value==='over50'?price>50000:true;
  const applyFilters=()=>{
    let visible=0;
    cards.forEach(card=>{
      const show=(type.value==='all'||card.dataset.type===type.value)
        &&(width.value==='all'||card.dataset.width===width.value)
        &&matchesBudget(Number(card.dataset.price));
      card.hidden=!show;
      if(show)visible++;
    });
    const ordered=[...cards].sort((a,b)=>sort.value==='price-asc'
      ?Number(a.dataset.price)-Number(b.dataset.price)
      :sort.value==='price-desc'
        ?Number(b.dataset.price)-Number(a.dataset.price)
        :cards.indexOf(a)-cards.indexOf(b));
    ordered.forEach(card=>grid.appendChild(card));
    result.textContent=visible
      ?'Показано моделей: '+visible+' из '+cards.length
      :'По выбранным параметрам моделей не найдено. Измените фильтры.';
  };
  [type,width,budget,sort].forEach(control=>control.addEventListener('change',applyFilters));
  reset.addEventListener('click',()=>{
    type.value='all';
    width.value='all';
    budget.value='all';
    sort.value='default';
    applyFilters();
    type.focus();
  });
  applyFilters();
})();
