'use strict';
(() => {
  const $ = (selector) => document.querySelector(selector);
  const loginView = $('#login-view');
  const appView = $('#app-view');
  const loginForm = $('#login-form');
  const productDialog = $('#product-dialog');
  const productForm = $('#product-form');
  const state = { csrf: '', products: [], orders: [], categories: [], settings: {}, tab: 'products' };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const money = (value) => value == null ? 'Цена не указана' : new Intl.NumberFormat('ru-RU').format(value) + ' ₽';
  const notice = (message, bad = false) => { $('#notice').textContent = message; $('#notice').classList.toggle('bad', bad); };
  async function api(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (state.csrf && options.method && !['GET','HEAD'].includes(options.method.toUpperCase())) headers.set('x-csrf-token', state.csrf);
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
    const type = response.headers.get('content-type') || '';
    const body = type.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) throw new Error(body && body.error ? body.error : 'Ошибка запроса (' + response.status + ')');
    return body;
  }
  function showApp(username) {
    loginView.hidden = true; appView.hidden = false; $('#user-label').textContent = username || 'Администратор';
    loadAll().catch((error) => notice(error.message, true));
  }
  async function loadAll() {
    const [products, orders, categories, settings] = await Promise.all([api('/api/admin/products'), api('/api/admin/orders'), api('/api/admin/categories'), api('/api/admin/settings')]);
    state.products = products; state.orders = orders; state.categories = categories; state.settings = settings;
    $('#product-count').textContent = products.length; $('#order-count').textContent = orders.length;
    renderProducts(); renderOrders(); renderCategories(); fillSettings();
  }
  function renderProducts() {
    const root = $('#product-list');
    if (!state.products.length) { root.innerHTML = '<p class="muted">В каталоге пока нет товаров. Добавьте первую позицию.</p>'; return; }
    root.innerHTML = state.products.map((p) => '<article class="item"><img class="thumb" src="' + esc(p.image || '/favicon.svg') + '" alt="" loading="lazy"><div><h3>' + esc(p.name) + '</h3><p>' + esc(p.category) + ' · ' + esc(money(p.price)) + (p.active ? '' : ' · скрыт') + '</p></div><div class="item-actions"><button class="small-btn" data-edit="' + Number(p.id) + '" type="button">Изменить</button><button class="small-btn" data-product-toggle="' + Number(p.id) + '" type="button">'+(p.active ? 'Скрыть' : 'Опубликовать')+'</button><button class="small-btn danger" data-delete="' + Number(p.id) + '" type="button">Удалить</button></div></article>').join('');
  }
  function renderOrders() {
    const root = $('#order-list');
    if (!state.orders.length) { root.innerHTML = '<p class="muted">Заявок пока нет.</p>'; return; }
    const labels = {new:'Новая',in_progress:'В работе',completed:'Завершена',cancelled:'Отменена'};
    root.innerHTML = state.orders.map((o) => '<article class="order-item"><div><h3>Заявка №' + Number(o.id) + ' · ' + esc(o.name) + '</h3><p><strong>Контакт:</strong> ' + esc(o.contact) + '</p><p>' + esc(o.message || 'Без комментария') + '</p><p>' + esc(o.created_at) + '</p></div><label>Статус<select data-order="' + Number(o.id) + '">' + Object.entries(labels).map(([value,label]) => '<option value="' + value + '"' + (o.status === value ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label></article>').join('');
  }
  function renderCategories() {
    const root = $('#category-list');
    if (!state.categories.length) { root.innerHTML = '<p class="muted">Категорий пока нет.</p>'; return; }
    root.innerHTML = state.categories.map((c) => '<article class="item category-item"><div class="category-symbol">#</div><div><h3>' + esc(c.name) + '</h3><p>' + esc(c.slug) + ' · порядок: ' + Number(c.sort_order) + (c.description ? ' · ' + esc(c.description) : '') + (c.active ? '' : ' · скрыта') + '</p></div><div class="item-actions"><button class="small-btn" data-category-edit="' + Number(c.id) + '" type="button">Изменить</button><button class="small-btn" data-category-toggle="' + Number(c.id) + '" type="button">'+(c.active ? 'Скрыть' : 'Опубликовать')+'</button><button class="small-btn danger" data-category-delete="' + Number(c.id) + '" type="button">Удалить</button></div></article>').join('');
  }
  function fillSettings() {
    const form = $('#settings-form');
    for (const [key,value] of Object.entries(state.settings)) if (form.elements[key]) form.elements[key].value = value;
  }
  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
    $('#products-panel').hidden = tab !== 'products'; $('#orders-panel').hidden = tab !== 'orders'; $('#categories-panel').hidden = tab !== 'categories'; $('#settings-panel').hidden = tab !== 'settings';
  }
  function openProduct(product) {
    productForm.reset(); $('#form-error').textContent = '';
    productForm.elements.id.value = product ? product.id : '';
    productForm.elements.name.value = product ? product.name : '';
    const categorySelect = productForm.elements.category;
    categorySelect.innerHTML = '<option value="">Выберите категорию</option>' + state.categories.filter((item) => item.active).map((item) => '<option value="' + esc(item.name) + '">' + esc(item.name) + '</option>').join('');
    if (product && !state.categories.some((item) => item.name === product.category)) categorySelect.insertAdjacentHTML('beforeend', '<option value="' + esc(product.category) + '">' + esc(product.category) + ' (текущая)</option>');
    categorySelect.value = product ? product.category : '';
    productForm.elements.price.value = product && product.price != null ? product.price : '';
    productForm.elements.description.value = product ? product.description : '';
    productForm.elements.meta_title.value = product ? product.meta_title || '' : '';
    productForm.elements.meta_description.value = product ? product.meta_description || '' : '';
    productForm.elements.image.value = product ? product.image : '';
    $('#dialog-title').textContent = product ? 'Изменить товар' : 'Новый товар';
    productDialog.showModal();
  }
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault(); $('#login-error').textContent = '';
    const data = new FormData(loginForm);
    try {
      const result = await api('/api/admin/login', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({username:data.get('username'),password:data.get('password')}) });
      state.csrf = result.csrfToken; loginForm.reset(); showApp(result.username);
    } catch (error) { $('#login-error').textContent = error.message; }
  });
  $('#logout').addEventListener('click', async () => {
    try { await api('/api/admin/logout', {method:'POST'}); } catch {}
    state.csrf = ''; appView.hidden = true; loginView.hidden = false;
  });
  $('#refresh').addEventListener('click', () => loadAll().then(() => notice('Данные обновлены')).catch((error) => notice(error.message, true)));
  document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)));
  $('#add-product').addEventListener('click', () => openProduct(null));
  $('#close-dialog').addEventListener('click', () => productDialog.close());
  $('#cancel-dialog').addEventListener('click', () => productDialog.close());
  $('#product-list').addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-edit]'); const remove = event.target.closest('[data-delete]');
    const toggle = event.target.closest('[data-product-toggle]');
    if (edit) { const product = state.products.find((item) => item.id === Number(edit.dataset.edit)); if (product) openProduct(product); }
    if (toggle) {
      const product = state.products.find((item) => item.id === Number(toggle.dataset.productToggle));
      if (!product) return;
      try {
        await api('/api/admin/products/' + product.id + '/visibility', {method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({active:!Boolean(product.active)})});
        await loadAll(); notice(product.active ? 'Товар скрыт с витрины' : 'Товар опубликован');
      } catch (error) { notice(error.message,true); }
    }
    if (remove) {
      const id = Number(remove.dataset.delete); const product = state.products.find((item) => item.id === id);
      if (!product || !confirm('Удалить товар «' + product.name + '»?')) return;
      try { await api('/api/admin/products/' + id, {method:'DELETE'}); await loadAll(); notice('Товар удалён'); }
      catch (error) { notice(error.message, true); }
    }
  });
  productForm.addEventListener('submit', async (event) => {
    event.preventDefault(); $('#form-error').textContent = '';
    const form = new FormData(productForm); let image = String(form.get('image') || '').trim();
    let newlyUploadedImage = '';
    try {
      const file = form.get('file');
      if (file && file.size) {
        const upload = new FormData(); upload.append('image', file);
        const result = await api('/api/admin/upload', {method:'POST',body:upload});
        image = result.url; newlyUploadedImage = result.url;
      }
      const payload = {name:form.get('name'),category:form.get('category'),price:form.get('price'),description:form.get('description'),image,meta_title:form.get('meta_title'),meta_description:form.get('meta_description')};
      const id = form.get('id');
      await api(id ? '/api/admin/products/' + Number(id) : '/api/admin/products', {method:id?'PUT':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      newlyUploadedImage = '';
      productDialog.close(); await loadAll(); notice(id ? 'Изменения сохранены' : 'Товар добавлен');
    } catch (error) {
      if (newlyUploadedImage) {
        try { await api('/api/admin/upload/cleanup', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:newlyUploadedImage})}); } catch {}
      }
      $('#form-error').textContent = error.message;
    }
  });
  $('#order-list').addEventListener('change', async (event) => {
    const select = event.target.closest('[data-order]'); if (!select) return;
    try { await api('/api/admin/orders/' + Number(select.dataset.order), {method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:select.value})}); await loadAll(); notice('Статус заявки обновлён'); }
    catch (error) { notice(error.message, true); }
  });
  $('#category-form').addEventListener('submit', async (event) => {
    event.preventDefault(); $('#category-error').textContent = '';
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/admin/categories', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:form.get('name'),slug:form.get('slug'),sort_order:Number(form.get('sort_order')),description:form.get('description')})});
      event.currentTarget.reset(); event.currentTarget.elements.sort_order.value = '0';
      await loadAll(); notice('Категория добавлена');
    } catch (error) { $('#category-error').textContent = error.message; }
  });
  $('#category-list').addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-category-edit]'); const remove = event.target.closest('[data-category-delete]');
    const toggle = event.target.closest('[data-category-toggle]');
    if (toggle) {
      const category = state.categories.find((item) => item.id === Number(toggle.dataset.categoryToggle));
      if (!category) return;
      try {
        await api('/api/admin/categories/' + category.id, {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({name:category.name,slug:category.slug,sort_order:Number(category.sort_order),description:category.description || '',active:!Boolean(category.active)})});
        await loadAll(); notice(category.active ? 'Категория скрыта' : 'Категория опубликована');
      } catch (error) { notice(error.message,true); }
    }
    if (edit) {
      const category = state.categories.find((item) => item.id === Number(edit.dataset.categoryEdit));
      if (!category) return;
      const name = prompt('Название категории:', category.name); if (name === null) return;
      const slug = prompt('URL-идентификатор:', category.slug); if (slug === null) return;
      const order = prompt('Порядок отображения:', String(category.sort_order)); if (order === null) return;
      const description = prompt('SEO-описание категории:', category.description || ''); if (description === null) return;
      try { await api('/api/admin/categories/' + category.id, {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({name,slug,sort_order:Number(order),description,active:Boolean(category.active)})}); await loadAll(); notice('Категория обновлена'); }
      catch (error) { notice(error.message,true); }
    }
    if (remove) {
      const id = Number(remove.dataset.categoryDelete); const category = state.categories.find((item) => item.id === id);
      if (!category || !confirm('Удалить категорию «' + category.name + '»?')) return;
      try { await api('/api/admin/categories/' + id, {method:'DELETE'}); await loadAll(); notice('Категория удалена'); }
      catch (error) { notice(error.message,true); }
    }
  });
  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault(); $('#settings-error').textContent = '';
    const form = new FormData(event.currentTarget); const payload = Object.fromEntries(form.entries());
    try { state.settings = await api('/api/admin/settings', {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}); fillSettings(); notice('Настройки сохранены'); }
    catch (error) { $('#settings-error').textContent = error.message; }
  });
  api('/api/admin/me').then((result) => { state.csrf = result.csrfToken; showApp(result.username); }).catch(() => { loginView.hidden = false; appView.hidden = true; });
})();