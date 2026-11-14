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
    document.body.classList.remove('menu-open');
    menuButton.setAttribute('aria-expanded','false');
    menuButton.setAttribute('aria-label','Открыть меню');
    if(returnFocus)menuButton.focus();
  };
  const openMenu=()=>{
    nav.classList.add('open');
    document.body.classList.add('menu-open');
    menuButton.setAttribute('aria-expanded','true');
    menuButton.setAttribute('aria-label','Закрыть меню');
    const first=nav.querySelector('a,summary');
    first?.focus({preventScroll:true});
  };
  menuButton.addEventListener('click',()=>menuButton.getAttribute('aria-expanded')==='true'?closeMenu():openMenu());
  nav.querySelectorAll('a').forEach(link=>link.addEventListener('click',()=>closeMenu()));
  nav.querySelectorAll('.nav-group').forEach(group=>group.addEventListener('toggle',()=>{
    if(group.open)nav.querySelectorAll('.nav-group').forEach(other=>{if(other!==group)other.open=false;});
  }));
  document.addEventListener('keydown',event=>{
    if(!nav.classList.contains('open'))return;
    if(event.key==='Escape'){closeMenu({returnFocus:true});return;}
    if(event.key==='Tab'){
      const focusable=[...nav.querySelectorAll('a,summary,button')].filter(node=>node.getClientRects().length>0&&!node.hasAttribute('disabled'));
      if(!focusable.length)return;
      const first=focusable[0],last=focusable[focusable.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
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

let currentSelection='';
document.getElementById('finderForm')?.addEventListener('submit',event=>{
  event.preventDefault();
  const values=Object.fromEntries(new FormData(event.currentTarget).entries());
  const labels={type:'Тип установки',width:'Ширина',family:'Состав семьи',budget:'Бюджет'};
  currentSelection='DOMA TECH — мой профиль подбора\n\n'+Object.entries(values).map(([key,value])=>labels[key]+': '+value).join('\n')+'\n\nПеред покупкой проверьте точные габариты ниши, подключение, уровень шума, расход воды, гарантию и наличие у продавца.';
  const output=document.getElementById('finderResult');
  if(output){
    output.hidden=false;
    output.textContent='Ваш профиль готов. '+Object.entries(values).map(([key,value])=>labels[key].toLowerCase()+': '+value).join(' · ')+'. Ниже можно сохранить его в текстовый файл.';
  }
  const download=document.getElementById('downloadSelection');
  if(download)download.hidden=false;
  notify('Профиль подбора сформирован в этом браузере.');
});
document.getElementById('downloadSelection')?.addEventListener('click',()=>{
  if(!currentSelection)return;
  const blob=new Blob([currentSelection],{type:'text/plain;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;link.download='doma-tech-profile.txt';
  document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);
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


/* Подключение управляемых настроек и каталога на серверной версии.
   На GitHub Pages API недоступен — статическая витрина продолжает работать как раньше. */
(async () => {
  try {
    const response = await fetch('/api/site-config', { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) return;
    const config = await response.json();
    const settings = config.settings || {};
    const setText = (selector, value) => {
      const node = document.querySelector(selector);
      if (node && typeof value === 'string' && value.trim()) node.textContent = value;
    };
    if (settings.meta_title) document.title = settings.meta_title;
    if (settings.meta_description) {
      let description = document.querySelector('meta[name="description"]');
      if (description) description.content = settings.meta_description;
      let ogDescription = document.querySelector('meta[property="og:description"]');
      if (ogDescription) ogDescription.content = settings.meta_description;
    }
    if (settings.meta_title) {
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) ogTitle.content = settings.meta_title;
    }
    setText('.hero h1', settings.hero_title);
    setText('.hero-lead', settings.hero_subtitle);
    setText('.hero-actions .button', settings.hero_cta_text);
    if (Array.isArray(config.categories)) {
      const grid = document.querySelector('.category-grid');
      if (grid) {
        const fragment = document.createDocumentFragment();
        config.categories.forEach((category, index) => {
          const button = document.createElement('a');
          button.className = 'category-card';
          button.href = '/catalog/' + encodeURIComponent(category.slug);
          const number = document.createElement('span');
          number.className = 'category-num';
          number.textContent = String(index + 1).padStart(2, '0') + ' / ' + category.name.toLocaleUpperCase('ru-RU');
          const visual = document.createElement('span');
          visual.className = 'appliance appliance-built';
          visual.setAttribute('aria-hidden', 'true');
          const title = document.createElement('strong');
          title.textContent = category.name;
          const hint = document.createElement('small');
          hint.textContent = 'Перейти к подбору';
          const arrow = document.createElement('span');
          arrow.className = 'card-arrow';
          arrow.textContent = '↗';
          button.append(number, visual, title, hint, arrow);
          fragment.append(button);
        });
        grid.replaceChildren(fragment);
      }
    }
    const productsResponse = await fetch('/api/products', { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (productsResponse.ok) {
      const products = await productsResponse.json();
      if (Array.isArray(products) && products.length) {
        let section = document.querySelector('#managed-catalog');
        if (!section) {
          section = document.createElement('section');
          section.id = 'managed-catalog';
          section.className = 'section catalog-preview';
          const existing = document.querySelector('#market-examples');
          if (existing) existing.before(section);
          else document.querySelector('main')?.append(section);
        }
        const heading = document.createElement('div');
        heading.className = 'section-heading';
        const titleWrap = document.createElement('div');
        const eyebrow = document.createElement('div');
        eyebrow.className = 'eyebrow';
        eyebrow.textContent = 'КАТАЛОГ DOMA TECH';
        const title = document.createElement('h2');
        title.textContent = 'Товары каталога';
        titleWrap.append(eyebrow, title);
        const intro = document.createElement('p');
        intro.textContent = 'Позиции, добавленные администратором. Наличие и условия уточняйте перед заказом.';
        heading.append(titleWrap, intro);
        const grid = document.createElement('div');
        grid.className = 'market-grid managed-product-grid';
        products.forEach(product => {
          const card = document.createElement('article');
          card.className = 'market-card managed-product-card';
          const productLink = document.createElement('a');
          productLink.className = 'managed-product-link';
          productLink.href = product.slug ? '/product/' + encodeURIComponent(product.slug) : '#catalog';
          const visual = document.createElement('div');
          visual.className = 'market-visual';
          if (product.image) {
            const img = document.createElement('img');
            img.className = 'market-photo';
            img.src = product.image;
            img.alt = product.name;
            img.loading = 'lazy';
            img.decoding = 'async';
            visual.append(img);
          }
          const info = document.createElement('div');
          info.className = 'market-info';
          const category = document.createElement('small');
          category.textContent = product.category;
          const name = document.createElement('h3');
          name.textContent = product.name;
          const description = document.createElement('p');
          description.textContent = product.description || 'Подробности уточняйте у консультанта.';
          const price = document.createElement('strong');
          price.textContent = product.price == null ? 'Цена по запросу' : new Intl.NumberFormat('ru-RU').format(product.price) + ' ₽';
          info.append(category, name, description, price);
          productLink.append(visual, info);
          card.append(productLink);
          grid.append(card);
        });
        section.replaceChildren(heading, grid);
      }
    }
  } catch {
    // Static GitHub Pages and offline previews keep their original content.
  }
})();
