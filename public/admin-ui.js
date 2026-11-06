const feedback = document.querySelector('#feedback');
const nav = document.querySelector('.admin-navigation');
const productsNav = document.querySelector('.nav-products');
const compact = matchMedia('(max-width:47rem)');
function setNavigation() {
  nav.open = !compact.matches;
  try {
    if (compact.matches) nav.open = localStorage.getItem('admin-mobile-menu') === 'open';
    if (!productsNav.hasAttribute('data-active')) productsNav.open = localStorage.getItem('admin-products-menu') === 'open';
  } catch {}
}
setNavigation();
compact.addEventListener('change', setNavigation);
nav.addEventListener('toggle', () => {
  if (compact.matches) try { localStorage.setItem('admin-mobile-menu', nav.open ? 'open' : 'closed'); } catch {}
});
productsNav.addEventListener('toggle', () => {
  try { localStorage.setItem('admin-products-menu', productsNav.open ? 'open' : 'closed'); } catch {}
});
function notice(message, error = false) {
  feedback.hidden = false;
  feedback.setAttribute('role', error ? 'alert' : 'status');
  feedback.textContent = message;
  if (error) feedback.scrollIntoView({ block: 'nearest' });
}
async function send(url, data) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with':'XMLHttpRequest' }, body: JSON.stringify(data), redirect: 'manual' });
  if (res.type === 'opaqueredirect' || res.status === 401 || !res.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Sessão encerrada ou serviço indisponível. Entre novamente no painel em outra aba para preservar o formulário.');
  }
  const value = await res.json();
  if (!res.ok) throw new Error(value.error);
  return value;
}
function upload(url, file, progress, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = new XMLHttpRequest();
    req.open('POST', url);
    req.setRequestHeader('content-type', file.type || 'application/octet-stream');
    for (const [key, value] of Object.entries(headers)) req.setRequestHeader(key, encodeURIComponent(value));
    progress.hidden = false;
    progress.value = 0;
    req.upload.onprogress = (event) => { if (event.lengthComputable) progress.value = 100 * event.loaded / event.total; };
    req.onload = () => {
      try {
        const data = JSON.parse(req.responseText);
        if (req.status >= 200 && req.status < 300) resolve(data);
        else reject(new Error(data.error));
      } catch { reject(new Error('Sessão expirada ou erro no envio.')); }
    };
    req.onerror = () => reject(new Error('Falha de conexão no envio.'));
    req.onloadend = () => { progress.hidden = true; };
    req.send(file);
  });
}
async function perform(button, operation) {
  button.disabled = true;
  try { await operation(); }
  catch (error) { notice(error.message || 'Não foi possível concluir a operação.', true); }
  finally { button.disabled = false; }
}
for (const form of document.querySelectorAll('[data-coupon]')) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    perform(event.submitter, async () => {
      const data = Object.fromEntries(new FormData(form));
      await send('/admin/api/cupons',{...data,revision:Number(data.revision),maxUses:Number(data.maxUses),active:form.elements.active.checked});
      const url = new URL(location.href);
      url.searchParams.set('salvo','1');
      location.assign(url);
    });
  });
}
if (location.pathname==='/admin/descontos' && new URLSearchParams(location.search).has('salvo')) notice('Cupom salvo.');
for (const form of document.querySelectorAll('[data-category]')) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    perform(event.submitter, async () => {
      if (!confirm('Alterar a categoria de todos os produtos com este nome?')) return;
      await send('/admin/api/categorias',Object.fromEntries(new FormData(form)));
      location.reload();
    });
  });
}
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => perform(button, async () => {
    if (button.dataset.confirm && !confirm(button.dataset.confirm)) return;
    const { sku, revision, action } = button.dataset;
    const saved = await send('/admin/api/produtos/' + sku + '/' + action, { revision: Number(revision) });
    if (action === 'duplicar') location.assign('/admin/produtos/' + saved.sku + '?salvo=1');
    else location.reload();
  }));
}
for (const button of document.querySelectorAll('[data-file-toggle]')) {
  button.addEventListener('click', () => perform(button, async () => {
    const { sku, version, enabled } = button.dataset;
    if (enabled === 'false' && !confirm('Bloquear este arquivo para novas compras?')) return;
    await send('/admin/api/arquivos/permissao', { sku, version, enabled: enabled === 'true' });
    location.reload();
  }));
}
const fileForm = document.querySelector('[data-private-upload]');
fileForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  perform(event.submitter, async () => {
    const data = new FormData(fileForm);
    await upload('/admin/api/arquivos/upload', data.get('file'), fileForm.querySelector('progress'),
      { 'x-sku': data.get('sku'), 'x-version': data.get('version'), 'x-filename': data.get('file').name });
    location.reload();
  });
});
const settings = document.querySelector('[data-settings]');
settings?.addEventListener('submit', (event) => {
  event.preventDefault();
  perform(event.submitter, async () => {
    const data = Object.fromEntries(new FormData(settings));
    await send('/admin/api/configuracoes', { ...data, period: Number(data.period) });
    notice('Configurações salvas.');
  });
});

const editor = document.querySelector('[data-product]');
if (editor) {
  const images = JSON.parse(editor.elements.images.value);
  const list = document.querySelector('#images');
  const dirty = document.querySelector('#dirty');
  let changed = false;
  function mark() { changed = true; dirty.textContent = 'Alterações não salvas'; }
  function showImages() {
    list.replaceChildren(...images.map((image, index) => {
      const figure = document.createElement('figure');
      const preview = new Image();
      preview.src = image.src.startsWith('/midia/') ? '/admin' + image.src : image.src;
      preview.alt = image.alt;
      const caption = document.createElement('figcaption');
      caption.textContent = (index === 0 ? 'Capa · ' : '') + image.alt;
      figure.append(preview, caption);
      const actions = [['Remover', () => images.splice(index, 1)]];
      if (index > 0) actions.unshift(['Mover antes', () => { [images[index - 1], images[index]] = [images[index], images[index - 1]]; }]);
      for (const [label, change] of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'quiet';
        button.textContent = label;
        button.setAttribute('aria-label', label + ' ' + image.alt);
        button.addEventListener('click', () => { change(); mark(); showImages(); });
        figure.append(button);
      }
      return figure;
    }));
  }
  showImages();
  editor.addEventListener('input', mark);
  window.addEventListener('beforeunload', (event) => { if (changed) event.preventDefault(); });
  if (new URLSearchParams(location.search).has('salvo')) notice('Produto salvo.');

  const name = editor.elements.namedItem('name');
  const slug = editor.elements.slug;
  name.addEventListener('input', () => {
    if (slug.dataset.manual || Number(editor.elements.revision.value)) return;
    slug.value = name.value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100).replace(/-$/, '');
  });
  slug.addEventListener('input', () => { slug.dataset.manual = '1'; });
  const description = editor.elements.description;
  for (const button of editor.querySelectorAll('[data-format]')) {
    button.addEventListener('click', () => {
      const format = button.dataset.format;
      const selected = description.value.slice(description.selectionStart, description.selectionEnd) || 'texto';
      const wrapped = format === 'link' ? '[' + selected + '](https://exemplo.com)' :
        format === '**' || format === '_' ? format + selected + format : '\n' + format + selected;
      description.setRangeText(wrapped, description.selectionStart, description.selectionEnd, 'end');
      description.focus();
      mark();
    });
  }
  const previewButton = editor.querySelector('[data-preview-text]');
  previewButton.addEventListener('click', () => perform(previewButton, async () => {
    const result = await send('/admin/api/previa', { description: description.value });
    const preview = document.querySelector('#rich-preview');
    preview.innerHTML = result.html;
    preview.hidden = false;
  }));

  const imageButton = editor.querySelector('[data-add-image]');
  imageButton.addEventListener('click', () => perform(imageButton, async () => {
    const field = document.querySelector('#image-file');
    const file = field.files[0];
    const alt = editor.elements['image-alt'];
    const url = editor.elements['image-url'];
    if (!alt.value.trim() || (!file && !url.value.trim()) || images.length >= 12) throw new Error('Informe uma imagem e seu texto alternativo. O limite é de 12 prévias.');
    if (file && (file.size > 900 * 1024 || !['image/jpeg','image/png','image/webp'].includes(file.type))) throw new Error('Use JPEG, PNG ou WebP de até 900 KB.');
    const previewUrl = file ? URL.createObjectURL(file) : new URL(url.value).href;
    if (!file && !previewUrl.startsWith('https://')) throw new Error('Use uma URL HTTPS.');
    const preview = new Image();
    preview.src = previewUrl;
    try { await preview.decode(); }
    catch { throw new Error('A imagem não pôde ser carregada.'); }
    finally { if (file) URL.revokeObjectURL(previewUrl); }
    if (preview.naturalWidth > 8000 || preview.naturalHeight > 8000) throw new Error('A imagem excede 8.000 pixels.');
    const src = file ? (await upload('/admin/api/imagens', file, document.querySelector('#image-progress'))).src : previewUrl;
    images.push({ src, alt: alt.value.trim(), width: preview.naturalWidth, height: preview.naturalHeight });
    alt.value = url.value = field.value = '';
    mark(); showImages();
  }));

  function save(button, draft) {
    if (!editor.reportValidity()) return;
    return perform(button, async () => {
      const data = Object.fromEntries(new FormData(editor));
      const { sku } = await send(editor.dataset.url, {
        ...data, images, featured: editor.elements.featured.checked, status: draft ? 'draft' : data.status,
      });
      changed = false;
      location.assign('/admin/produtos/' + sku + '?salvo=1');
    });
  }
  editor.addEventListener('submit', (event) => { event.preventDefault(); save(event.submitter, false); });
  const draftButton = editor.querySelector('[data-save-draft]');
  draftButton?.addEventListener('click', () => save(draftButton, true));
}
