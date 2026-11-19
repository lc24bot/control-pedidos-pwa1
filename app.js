/* Control de Pedidos — sin conexiones externas ni librerías remotas. */
(() => {
  'use strict';
  const DB_NAME = 'control-pedidos-local';
  const DB_VERSION = 1;
  const STORE_NAMES = ['clients', 'branches', 'products', 'orders', 'cuts'];
  const OCCASIONAL = '__occasional__';
  const isOccasional = order => order.kind === 'occasional';
  const occasionalPrice = product => product.occasionalPriceCents ?? (product.id === 'tortilla' ? 6 : null);
  const selectedOccasional = () => $('order-client').value === OCCASIONAL;
  const PAGES = { inicio: 'Resumen de pedidos', clientes: 'Clientes y sucursales', productos: 'Catálogo de productos', pedidos: 'Registro de pedidos', cortes: 'Cortes para Facta', respaldos: 'Respaldos y datos' };
  const TODAY = () => { const d = new Date(); return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'); };
  const money = cents => new Intl.NumberFormat('es-SV', {style:'currency',currency:'USD'}).format((cents || 0) / 100);
  const number = n => new Intl.NumberFormat('es-SV', {maximumFractionDigits:3}).format(n || 0);
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const uid = () => {
    if(crypto.randomUUID)return crypto.randomUUID();
    // getRandomValues también funciona en HTTP local; randomUUID requiere HTTPS.
    const bytes=crypto.getRandomValues(new Uint8Array(16));
    bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  };
  const parsePrice = raw => {
    if (!/^(\d+)(\.\d{1,2})?$/.test(String(raw).trim())) throw new Error('Escribe un precio válido con máximo dos decimales.');
    const [whole, fraction=''] = String(raw).trim().split('.');
    const value = Number(whole)*100 + Number(fraction.padEnd(2,'0'));
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('El precio está fuera del rango permitido.');
    return value;
  };
  let db, currentPage = 'inicio', basket = [], activePreview = null, savingOrder = false;
  let state = {clients:[],branches:[],products:[],orders:[],cuts:[]};
  let toastTimer;
  let previousOrderClient = '';
  let editingClientId = null, editingBranchId = null;
  const CLIENT_FIELDS = ['name','tradeName','nit','nrc','activity','activityCode','fiscalAddress','note'];
  const FISCAL_FIELDS = [['name','Razón social'],['nit','NIT'],['nrc','NRC'],['activity','Giro o actividad económica'],['activityCode','Código de actividad económica'],['fiscalAddress','Dirección fiscal']];
  const missingFiscal = client => FISCAL_FIELDS.filter(([key]) => !String(client?.[key] ?? '').trim()).map(([,label]) => label);
  function fiscalStatus(client) {
    const missing = missingFiscal(client);
    if(client?.requiresCcf === true) return missing.length ? `ADVERTENCIA: requiere CCF; faltan ${missing.join(', ')}. No habilitado para preparar datos fiscales. Los pedidos pueden continuar.` : 'Datos completos para preparar CCF; pendientes de revisión en Facta.';
    return 'Solo control de pedidos. No habilitado para preparar datos fiscales; selecciona Requiere CCF y completa los campos para habilitarlo.';
  }
  function fiscalRows(clientId) {
    const client = state.clients.find(row=>row.id===clientId) || {};
    return [['Datos fiscales','Datos actuales del cliente principal; no constituyen una copia del CCF emitido'], ...FISCAL_FIELDS.map(([key,label])=>[label,client[key] || 'No registrado']),['Nombre comercial',client.tradeName || 'No registrado'],['Requiere CCF',client.requiresCcf === true ? 'Sí' : 'No'],['Estado de datos fiscales',fiscalStatus(client)]];
  }
  function fiscalHtml(clientId) {
    return `<div class="tax-note">${fiscalRows(clientId).map(([label,value])=>`<div><strong>${esc(label)}:</strong> ${esc(value)}</div>`).join('')}</div>`;
  }
  function updateFiscalRequired() {
    const required = $('client-requiresCcf').value === 'si';
    FISCAL_FIELDS.forEach(([key])=>$(`client-${key}`).required = key === 'name' || required);
    $('client-fiscal-help').textContent = required ? 'Completa todos los datos fiscales con la razón social del cliente. Nombre comercial adicional y observaciones son opcionales. Se verifica presencia, no validez fiscal.' : 'Para control de pedidos puedes dejar datos fiscales incompletos. No quedará habilitado para preparar datos fiscales.';
  }
  function resetClientForm() {
    editingClientId=null;$('client-form').reset();$('client-form-title').textContent='Agregar cliente';$('cancel-client-edit').hidden=true;updateFiscalRequired();
  }
  function resetBranchForm() {
    editingBranchId=null;$('branch-form').reset();$('branch-client').disabled=false;$('branch-form-title').textContent='Agregar sucursal';$('cancel-branch-edit').hidden=true;
  }
  function invalidateFiscalPreview() {
    activePreview=null;
    $('cut-preview').innerHTML='<div class="empty-state">Los datos del cliente o sucursal cambiaron. Calcula el resumen nuevamente para ver la información actualizada.</div>';
  }

  function notify(message, error=false) {
    const toast = $('toast');
    toast.textContent = `${error?'⚠️':'✓'}  ${message}`;
    toast.className = 'toast';
    if (error) toast.style.background = '#8f3837'; else toast.style.background = '';
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.hidden = true, 6500);
  }
  function handleError(error) {
    console.error(error);
    notify(error?.message || 'No se pudo completar la operación.', true);
  }
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        for (const name of STORE_NAMES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name,{keyPath:'id'});
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Cierra otras pestañas de esta aplicación para continuar.'));
      request.onsuccess = () => resolve(request.result);
    });
  }
  function queryStore(name) {
    return new Promise((resolve,reject) => {
      const request = db.transaction(name,'readonly').objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function writeStore(name, record) {
    return new Promise((resolve,reject) => {
      const tx = db.transaction(name,'readwrite');
      tx.objectStore(name).put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('No se guardaron los cambios.'));
    });
  }
  function multiWrite(work) {
    return new Promise((resolve,reject) => {
      const tx = db.transaction(STORE_NAMES,'readwrite');
      try { work(tx); } catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('No se completó la operación.'));
    });
  }
  async function readData() {
    const values = await Promise.all(STORE_NAMES.map(queryStore));
    STORE_NAMES.forEach((name,i) => state[name] = values[i]);
    renderAll();
  }
  const clientName = id => state.clients.find(row=>row.id===id)?.name || 'Cliente no disponible';
  const branchName = id => { const row=state.branches.find(v=>v.id===id); return row ? (row.alias || row.name) : 'Sucursal no disponible'; };
  const orderBuyer = order => isOccasional(order) ? 'Venta ocasional' : clientName(order.clientId);
  const orderLocation = order => isOccasional(order) ? (order.buyerReference || 'Sin referencia') : branchName(order.branchId);
  const productName = id => state.products.find(row=>row.id===id)?.name || 'Producto no disponible';
  const orderNet = order => order.lines.reduce((sum,line)=>sum+line.totalCents,0);
  const orderQty = (order,productId='tortilla') => order.lines.filter(line=>line.productId===productId).reduce((sum,line)=>sum+line.quantity,0);
  function setOptions(select, rows, text, {placeholder='Selecciona…', all=false}={}) {
    const oldValue = select.value;
    select.replaceChildren(new Option(placeholder,'',true,false));
    rows.forEach(row => select.add(new Option(text(row),row.id)));
    if (rows.some(row=>row.id===oldValue)) select.value=oldValue;
    else if (all) select.value='';
  }
  function navigate(page) {
    if (!PAGES[page]) return;
    currentPage = page;
    document.querySelectorAll('.page').forEach(el => el.classList.toggle('active',el.id===`page-${page}`));
    document.querySelectorAll('[data-page]').forEach(el => el.classList.toggle('active',el.dataset.page===page));
    $('page-heading').textContent = PAGES[page];
    window.scrollTo({top:0,behavior:'auto'});
  }
  function renderAll() {
    renderSelections(); renderClients(); renderProducts(); renderOrders(); renderDashboard(); renderCuts(); updateStorageInfo();
  }
  function renderSelections() {
    const clients=[...state.clients].sort((a,b)=>a.name.localeCompare(b.name,'es'));
    for(const id of ['branch-client','cut-client']) setOptions($(id),clients,row=>row.name);
    setOptions($('order-client'),[{id:OCCASIONAL,name:'Cliente ocasional / Sin registrar'},...clients],row=>row.name);
    previousOrderClient=$('order-client').value;
    renderOrderProducts();
    updateOrderBranches(); updateCutBranches();
  }
  function renderOrderProducts() {
    setOptions($('order-product'),state.products.filter(row=>row.active!==false),row=>{
      const price=selectedOccasional()?occasionalPrice(row):row.priceCents;
      return `${row.name} · ${price===null?'Configura precio ocasional en Productos':money(price)+' / '+row.unit}`;
    });
    $('order-price-info').textContent=selectedOccasional()?'Venta ocasional · precio ocasional sin IVA. No se incluye en cortes para Facta.':'Precio del catálogo para clientes registrados, sin IVA.';
  }
  function changeOrderClient() {
    const changedType=(previousOrderClient===OCCASIONAL)!==selectedOccasional();
    if(changedType&&basket.length){
      if(!confirm('Al cambiar entre cliente registrado y ocasional se quitarán los productos del pedido sin guardar para aplicar la tarifa correcta. ¿Continuar?')){
        $('order-client').value=previousOrderClient;return;
      }
      basket=[];renderBasket();$('order-quantity').value='';
    }
    previousOrderClient=$('order-client').value;
    updateOrderBranches();renderOrderProducts();
  }
  function updateOrderBranches() {
    const id=$('order-client').value;
    const occasional=selectedOccasional();
    $('order-branch-field').hidden=occasional;
    $('order-branch').required=!occasional;$('order-branch').disabled=occasional;
    $('order-buyer-field').hidden=!occasional;$('order-buyer-reference').disabled=!occasional;
    setOptions($('order-branch'),state.branches.filter(row=>row.clientId===id && row.active!==false),row=>row.alias ? `${row.alias} — ${row.name}` : row.name);
  }
  function updateCutBranches() {
    const id=$('cut-client').value;
    const old=$('cut-branch').value;
    setOptions($('cut-branch'),state.branches.filter(row=>row.clientId===id),row=>row.alias || row.name,{placeholder:'Todas las sucursales',all:true});
    if(state.branches.some(row=>row.id===old&&row.clientId===id)) $('cut-branch').value=old;
  }
  function clientDetailsHtml(client) {
    const fields=[['name','Razón social o nombre comercial'],['tradeName','Nombre comercial adicional'],['nit','NIT'],['nrc','NRC'],['activity','Giro comercial'],['activityCode','Código de actividad económica'],['fiscalAddress','Dirección fiscal'],['note','Observaciones']];
    return `<details class="info"><summary>Consultar datos del cliente</summary><dl>${fields.map(([key,label])=>`<dt>${label}</dt><dd style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(client[key] || 'No registrado')}</dd>`).join('')}<dt>Requiere CCF</dt><dd>${client.requiresCcf===true?'Sí':'No'}</dd></dl></details>`;
  }
  function renderClients() {
    $('client-count').textContent = `${state.clients.length} clientes · ${state.branches.length} sucursales`;
    const list=$('client-list');
    if(!state.clients.length){list.innerHTML='<div class="empty-state">Agrega el primer cliente para comenzar.</div>';return;}
    list.innerHTML=state.clients.map(client=>{
      const branches=state.branches.filter(row=>row.clientId===client.id);
      return `<div class="client-card"><strong>${esc(client.name)}</strong><div class="sub">${client.nit?'NIT: '+esc(client.nit):'NIT no registrado'} · NRC: ${esc(client.nrc || 'No registrado')} · ${branches.length} sucursales</div><p class="info">${esc(fiscalStatus(client))}</p>${clientDetailsHtml(client)}<button class="small-btn" data-client-edit="${esc(client.id)}">Editar cliente</button><div class="branches">${branches.length?branches.map(branch=>`<div class="branch-tag"><strong>${esc(branch.name)} · ${esc(branch.alias)}</strong><p>${esc(branch.address || 'Dirección física pendiente')}</p><button class="small-btn" data-branch-edit="${esc(branch.id)}">Editar sucursal</button></div>`).join(''):'<span class="muted">Agrega una sucursal para poder registrar pedidos.</span>'}</div></div>`;
    }).join('');
    list.querySelectorAll('[data-client-edit]').forEach(button=>button.addEventListener('click',()=>{
      const client=state.clients.find(row=>row.id===button.dataset.clientEdit);
      editingClientId=client.id;CLIENT_FIELDS.forEach(key=>$(`client-${key}`).value=client[key] ?? '');
      $('client-requiresCcf').value=client.requiresCcf === true ? 'si' : 'no';updateFiscalRequired();
      $('client-form-title').textContent='Editar cliente';$('cancel-client-edit').hidden=false;$('client-name').focus();
    }));
    list.querySelectorAll('[data-branch-edit]').forEach(button=>button.addEventListener('click',()=>{
      const branch=state.branches.find(row=>row.id===button.dataset.branchEdit);
      editingBranchId=branch.id;['name','alias','address'].forEach(key=>$(`branch-${key}`).value=branch[key] ?? '');
      $('branch-client').value=branch.clientId;$('branch-client').disabled=true;
      $('branch-form-title').textContent='Editar sucursal';$('cancel-branch-edit').hidden=false;$('branch-name').focus();
    }));
  }
  function renderProducts() {
    if(!state.products.length){$('product-list').innerHTML='<div class="empty-state">Sin productos.</div>';return;}
    $('product-list').innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>Producto</th><th>Unidad</th><th>Precio registrado sin IVA</th><th>Precio ocasional sin IVA</th><th>Modificar</th></tr></thead><tbody>${state.products.map(row=>`<tr><td class="text-bold">${esc(row.name)}</td><td>${esc(row.unit)}</td><td class="money">${money(row.priceCents)}</td><td class="money">${occasionalPrice(row)===null?'Sin configurar':money(occasionalPrice(row))}</td><td><button class="small-btn" data-product-edit="${esc(row.id)}">Precio registrado</button> <button class="small-btn" data-occasional-price="${esc(row.id)}">Precio ocasional</button></td></tr>`).join('')}</tbody></table></div>`;
    document.querySelectorAll('[data-product-edit]').forEach(button=>button.addEventListener('click',async()=>{
      const product=state.products.find(row=>row.id===button.dataset.productEdit);
      const raw=prompt(`Nuevo precio de ${product.name} sin IVA (USD)`,(product.priceCents/100).toFixed(2));
      if(raw===null)return;
      try {await writeStore('products',{...product,priceCents:parsePrice(raw),updatedAt:new Date().toISOString()});await readData();notify('Precio actualizado. Los pedidos anteriores conservan su precio original.');}catch(error){handleError(error);}
    }));
    document.querySelectorAll('[data-occasional-price]').forEach(button=>button.addEventListener('click',async()=>{
      const product=state.products.find(row=>row.id===button.dataset.occasionalPrice);
      const previous=occasionalPrice(product);
      const raw=prompt(`Precio ocasional de ${product.name} sin IVA (USD). No cambia el precio registrado ni pedidos anteriores.`,previous===null?'':(previous/100).toFixed(2));
      if(raw===null)return;
      try{await writeStore('products',{...product,occasionalPriceCents:parsePrice(raw),updatedAt:new Date().toISOString()});await readData();notify('Precio ocasional actualizado. Los pedidos anteriores conservan su precio.');}catch(error){handleError(error);}
    }));
  }
  function renderBasket() {
    const list=$('order-lines');
    if(!basket.length)list.innerHTML='<div class="empty-state" style="padding:13px">Agrega un producto y su cantidad.</div>';
    else list.innerHTML=basket.map((line,index)=>`<div class="line-row"><span><strong>${esc(line.productName)}</strong><small class="muted"> · ${number(line.quantity)} × ${money(line.priceCents)}</small></span><span class="row-actions"><strong class="money">${money(line.totalCents)}</strong><button class="mini-delete" aria-label="Eliminar línea" data-remove-line="${index}">✕</button></span></div>`).join('');
    $('order-total').textContent=money(basket.reduce((s,line)=>s+line.totalCents,0));
    document.querySelectorAll('[data-remove-line]').forEach(button=>button.addEventListener('click',()=>{basket.splice(Number(button.dataset.removeLine),1);renderBasket();}));
  }
  function addLine() {
    const product=state.products.find(row=>row.id===$('order-product').value);
    if(!product)throw new Error('Selecciona un producto.');
    const raw=$('order-quantity').value;
    if(raw.trim()==='')throw new Error('Ingresa la cantidad antes de agregar el producto.');
    const quantity=Number(raw);
    if(!Number.isFinite(quantity)||quantity<=0||quantity>1000000)throw new Error('La cantidad debe ser mayor que cero y válida.');
    if(product.unit==='unidad'&&!Number.isInteger(quantity))throw new Error('Este producto requiere una cantidad entera.');
    if(Math.round(quantity*1000)!==quantity*1000 && product.unit!=='unidad')throw new Error('Utiliza máximo tres decimales para la cantidad.');
    const priceCents=selectedOccasional()?occasionalPrice(product):product.priceCents;
    if(!Number.isSafeInteger(priceCents)||priceCents<0)throw new Error('Configura el precio ocasional de este producto en Productos antes de agregarlo.');
    const totalCents=Math.round(quantity*priceCents);
    if(!Number.isSafeInteger(totalCents))throw new Error('El importe es demasiado grande.');
    basket.push({productId:product.id,productName:product.name,unit:product.unit,quantity,priceCents,totalCents});
    $('order-quantity').value='';$('order-quantity').focus();renderBasket();
  }
  function formatOrderStatus(status) {return ({registrado:'Registrado',entregado:'Entregado',cancelado:'Cancelado'})[status]||status;}
  function renderOrders() {
    let orders=[...state.orders].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    const from=$('filter-from').value,to=$('filter-to').value,status=$('filter-status').value;
    if(from)orders=orders.filter(row=>row.date>=from);
    if(to)orders=orders.filter(row=>row.date<=to);
    if(status)orders=orders.filter(row=>row.status===status);
    if(!orders.length){$('order-list').innerHTML='<div class="empty-state">No hay pedidos que coincidan con estos filtros.</div>';return;}
    $('order-list').innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>Fecha / Pedido</th><th>Cliente / Sucursal</th><th>Tortillas</th><th>Total</th><th>Estado</th></tr></thead><tbody>${orders.map(row=>{
      const cut=row.cutId?state.cuts.find(c=>c.id===row.cutId):null;
      const locked=cut&&cut.status!=='cancelado';
      return `<tr><td><strong>${esc(row.date)}</strong><div class="cut-note">#${esc(row.id.slice(0,8))}</div></td><td>${esc(orderLocation(row))}<div class="cut-note">${esc(orderBuyer(row))}</div></td><td class="text-bold">${number(orderQty(row))}</td><td class="money">${money(orderNet(row))}</td><td>${locked?`<span class="badge ${cut.status==='facturado'?'facturado':'preparado'}">${cut.status==='facturado'?'Facturado':'En corte'}</span>`:`<select aria-label="Estado del pedido" data-order-status="${esc(row.id)}"><option value="registrado" ${row.status==='registrado'?'selected':''}>Registrado</option><option value="entregado" ${row.status==='entregado'?'selected':''}>Entregado</option><option value="cancelado" ${row.status==='cancelado'?'selected':''}>Cancelado</option></select>`}</td></tr>`;
    }).join('')}</tbody></table></div>`;
    document.querySelectorAll('[data-order-status]').forEach(select=>select.addEventListener('change',async()=>{
      const order=state.orders.find(row=>row.id===select.dataset.orderStatus);
      if(!order)return;
      const next=select.value;
      if(next==='cancelado'&&!confirm('¿Confirmas que este pedido fue cancelado? No aparecerá en los cortes.')){select.value=order.status;return;}
      select.disabled=true;
      try{await writeStore('orders',{...order,status:next,updatedAt:new Date().toISOString()});await readData();notify(`Pedido #${order.id.slice(0,8)} actualizado: ${formatOrderStatus(next)}.`);}catch(error){handleError(error);select.disabled=false;}
    }));
  }
  function renderDashboard() {
    const todays=state.orders.filter(row=>row.date===TODAY());
    const delivered=todays.filter(row=>row.status==='entregado');
    const quantity=delivered.reduce((sum,row)=>sum+orderQty(row),0);
    const net=delivered.reduce((sum,row)=>sum+orderNet(row),0);
    const cards=[['Pedidos de hoy',todays.length,'Registrados para hoy'],['Entregados hoy',delivered.length,'Confirmados manualmente'],['Tortillas entregadas',number(quantity),'Cantidad real registrada'],['Importe entregado',money(net),'Sin IVA · Todos los productos']];
    $('stats').innerHTML=cards.map(([label,value,sub])=>`<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div>`).join('');
    const year=new Date().getFullYear();
    const monthly=Array.from({length:12},(_,i)=>state.orders.filter(row=>row.status==='entregado'&&row.date.startsWith(`${year}-${String(i+1).padStart(2,'0')}`)).reduce((sum,row)=>sum+orderQty(row),0));
    const highest=Math.max(...monthly,1);
    $('year-total').textContent=`${number(monthly.reduce((a,b)=>a+b,0))} uds.`;
    $('monthly-chart').innerHTML=monthly.map((value,i)=>`<div class="bar-holder" title="${new Intl.DateTimeFormat('es-SV',{month:'long'}).format(new Date(year,i,1))}: ${number(value)} tortillas"><div class="bar ${i===new Date().getMonth()?'selected':''}" style="height:${Math.max(2,Math.round(value/highest*170))}px"></div><div class="bar-label">${['E','F','M','A','M','J','J','A','S','O','N','D'][i]}</div></div>`).join('');
    const recent=[...state.orders].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,7);
    $('recent-orders').innerHTML=recent.length?recent.map(row=>`<div class="client-card"><div style="display:flex;justify-content:space-between;gap:10px"><div><strong>${isOccasional(row)?esc(orderBuyer(row))+' · ':''}${esc(orderLocation(row))}</strong><div class="sub">${esc(row.date)} · ${number(orderQty(row))} tortillas</div></div><div style="text-align:right"><strong class="money">${money(orderNet(row))}</strong><span class="badge ${esc(row.status)}">${formatOrderStatus(row.status)}</span></div></div></div>`).join(''):'<div class="empty-state">Los pedidos aparecerán aquí después de guardarlos.</div>';
  }
  function previewCut() {
    const clientId=$('cut-client').value,branchId=$('cut-branch').value;
    const from=$('cut-from').value,to=$('cut-to').value;
    if(!clientId||!from||!to)throw new Error('Selecciona cliente y fechas del corte.');
    if(from>to)throw new Error('La fecha inicial no puede ser posterior a la final.');
    const orders=state.orders.filter(row=>!isOccasional(row)&&row.clientId===clientId&&(!branchId||row.branchId===branchId)&&row.date>=from&&row.date<=to&&row.status==='entregado'&&!row.cutId);
    const groups=new Map();
    for(const order of orders)for(const line of order.lines){
      const group=groups.get(line.productId)||{productId:line.productId,name:line.productName,quantity:0,totalCents:0};
      group.quantity+=line.quantity;group.totalCents+=line.totalCents;groups.set(line.productId,group);
    }
    const net=orders.reduce((sum,row)=>sum+orderNet(row),0);
    return {clientId,branchId:branchId||null,from,to,orderIds:orders.map(row=>row.id),groups:[...groups.values()],netCents:net,tortillas:orders.reduce((sum,row)=>sum+orderQty(row),0)};
  }
  function cutSummaryHtml(cut,includeActions=false) {
    const iva=Math.round(cut.netCents*13/100);
    const rows=cut.groups.map(row=>`<tr><td>${esc(row.name)}</td><td class="text-right">${number(row.quantity)}</td><td class="text-right money">${money(row.totalCents)}</td></tr>`).join('');
    return `<div class="panel-heading"><div><h2>Resumen ${cut.branchId?'por sucursal':'consolidado'}</h2><p>${esc(clientName(cut.clientId))} · ${esc(cut.from)} al ${esc(cut.to)}</p></div></div><div class="summary-main"><div class="summary-metric"><small>Tortillas entregadas</small><strong>${number(cut.tortillas)}</strong></div><div class="summary-metric"><small>Total sin IVA</small><strong>${money(cut.netCents)}</strong></div></div><div class="info">${cut.orderIds.length} pedido(s) · ${cut.branchId?esc(branchName(cut.branchId)):'Todas las sucursales'}</div><div class="table-wrap"><table class="table"><thead><tr><th>Producto</th><th class="text-right">Cantidad</th><th class="text-right">Importe sin IVA</th></tr></thead><tbody>${rows}</tbody></table></div>${fiscalHtml(cut.clientId)}<div class="tax-note"><strong>Referencia para Facta DTE, no fiscal</strong><br>Subtotal sin IVA: ${money(cut.netCents)} · IVA estimado 13%: ${money(iva)} · Posible total con IVA: ${money(cut.netCents+iva)}</div>${includeActions?'<div class="cut-actions"><button class="button primary" id="create-cut">Guardar corte</button><button class="button secondary" id="copy-preview">Copiar resumen</button><button class="button secondary" id="csv-preview">CSV</button></div>':''}`;
  }
  function cutPlainText(cut) {
    return [`CONTROL DE PEDIDOS — RESUMEN PARA FACTA (NO FISCAL)`,`Cliente: ${clientName(cut.clientId)}`,...fiscalRows(cut.clientId).map(([label,value])=>`${label}: ${value}`),`Sucursales: ${cut.branchId?branchName(cut.branchId):'Todas'}`,`Período: ${cut.from} a ${cut.to}`,...cut.groups.map(row=>`${row.name}: ${number(row.quantity)} — ${money(row.totalCents)}`),`TORTILLAS: ${number(cut.tortillas)}`,`TOTAL SIN IVA: ${money(cut.netCents)}`,`IVA estimado 13%: ${money(Math.round(cut.netCents*13/100))}`,`TOTAL ESTIMADO CON IVA: ${money(cut.netCents+Math.round(cut.netCents*13/100))}`].join('\n');
  }
  async function copyText(value) {
    try {await navigator.clipboard.writeText(value);notify('Resumen copiado al portapapeles.');}
    catch (_) {prompt('Copia el resumen (Ctrl+C):',value);}
  }
  function downloadFile(fileName,body,type) {
    const link=document.createElement('a'),url=URL.createObjectURL(new Blob([body],{type}));
    link.href=url;link.download=fileName;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);
  }
  function safeCsvCell(value) {
    let text=String(value??'');
    if(/^[\s]*[=+@-]/.test(text))text="'"+text;
    return `"${text.replace(/"/g,'""')}"`;
  }
  function downloadCutCsv(cut) {
    const data=[['Cliente',clientName(cut.clientId)],...fiscalRows(cut.clientId),['Sucursal',cut.branchId?branchName(cut.branchId):'Todas'],['Desde',cut.from],['Hasta',cut.to],[],['Producto','Cantidad','Subtotal sin IVA'],...cut.groups.map(row=>[row.name,row.quantity,(row.totalCents/100).toFixed(2)]),[],['Total tortillas',cut.tortillas],['Subtotal sin IVA',(cut.netCents/100).toFixed(2)],['IVA estimado',(Math.round(cut.netCents*13/100)/100).toFixed(2)]];
    downloadFile(`corte-${cut.from}-${cut.to}.csv`,'\ufeff'+data.map(row=>row.map(safeCsvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8');
  }
  function showCutPreview(cut) {
    activePreview=cut;
    $('cut-preview').innerHTML=cut.orderIds.length?cutSummaryHtml(cut,true):'<div class="empty-state">No hay pedidos entregados y pendientes de facturar en ese período.</div>';
    if(!cut.orderIds.length){$('cut-preview').insertAdjacentHTML('beforeend',fiscalHtml(cut.clientId));return;}
    $('create-cut').addEventListener('click',createCut);
    $('copy-preview').addEventListener('click',()=>copyText(cutPlainText(activePreview)));
    $('csv-preview').addEventListener('click',()=>downloadCutCsv(activePreview));
  }
  async function createCut() {
    if(!activePreview?.orderIds.length)return;
    const button=$('create-cut');button.disabled=true;
    try {
      const cutData=previewCut();
      if(JSON.stringify(cutData)!==JSON.stringify(activePreview))throw new Error('La selección o los pedidos cambiaron. Calcula el resumen nuevamente.');
      const cut={...cutData,id:uid(),status:'preparado',createdAt:new Date().toISOString(),factaReference:null};
      await multiWrite(tx=>{
        tx.objectStore('cuts').add(cut);
        for(const id of cut.orderIds){
          const row=state.orders.find(order=>order.id===id);
          if(!row||row.cutId||row.status!=='entregado')throw new Error('Un pedido ya no está disponible para el corte.');
          tx.objectStore('orders').put({...row,cutId:cut.id,updatedAt:new Date().toISOString()});
        }
      });
      await readData();activePreview=null;
      $('cut-preview').innerHTML='<div class="empty-state">Corte guardado. Consulta la lista inferior para copiar el resumen y registrar el CCF después de emitirlo en Facta.</div>';
      notify(`Corte guardado con ${cut.orderIds.length} pedidos. Todavía NO está facturado.`);
    } catch(error){handleError(error);if(button)button.disabled=false;}
  }
  function renderCuts() {
    const cuts=[...state.cuts].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    $('cut-list').innerHTML=cuts.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Cliente y período</th><th>Tortillas</th><th>Total sin IVA</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${cuts.map(cut=>`<tr><td><div class="cut-title">${esc(clientName(cut.clientId))}</div><div class="cut-note">${esc(cut.from)} al ${esc(cut.to)} · ${cut.branchId?esc(branchName(cut.branchId)):'Consolidado'}</div></td><td class="text-bold">${number(cut.tortillas)}</td><td class="money">${money(cut.netCents)}</td><td><span class="badge ${esc(cut.status)}">${cut.status==='facturado'?'Facturado':cut.status==='cancelado'?'Cancelado':'Preparado'}</span></td><td><div class="row-actions"><button class="small-btn" data-cut-copy="${esc(cut.id)}">Copiar</button><button class="small-btn" data-cut-csv="${esc(cut.id)}">CSV</button>${cut.status==='preparado'?`<button class="small-btn" data-cut-bill="${esc(cut.id)}">Facturado</button><button class="small-btn" data-cut-cancel="${esc(cut.id)}">Cancelar</button>`:''}</div>${cut.factaReference?`<div class="cut-note">Ref. ${esc(cut.factaReference)}</div>`:''}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-state">Todavía no hay cortes preparados.</div>';
    document.querySelectorAll('[data-cut-copy]').forEach(btn=>btn.addEventListener('click',()=>{const cut=state.cuts.find(row=>row.id===btn.dataset.cutCopy);copyText(cutPlainText(cut));}));
    document.querySelectorAll('[data-cut-csv]').forEach(btn=>btn.addEventListener('click',()=>{const cut=state.cuts.find(row=>row.id===btn.dataset.cutCsv);downloadCutCsv(cut);}));
    document.querySelectorAll('[data-cut-bill]').forEach(btn=>btn.addEventListener('click',()=>completeBilling(btn.dataset.cutBill)));
    document.querySelectorAll('[data-cut-cancel]').forEach(btn=>btn.addEventListener('click',()=>cancelCut(btn.dataset.cutCancel)));
  }
  async function completeBilling(id) {
    const cut=state.cuts.find(row=>row.id===id);
    if(!cut||cut.status!=='preparado')return;
    const reference=prompt('Ingresa el código de generación o referencia del CCF ya emitido en Facta. Esto marcará los pedidos como facturados.');
    if(reference===null)return;
    if(!reference.trim())return notify('Debes introducir una referencia para confirmar la facturación.',true);
    try {await writeStore('cuts',{...cut,status:'facturado',factaReference:reference.trim(),billedAt:new Date().toISOString()});await readData();notify('Corte marcado como facturado. Los pedidos no se volverán a incluir.');}
    catch(error){handleError(error);}
  }
  async function cancelCut(id) {
    const cut=state.cuts.find(row=>row.id===id);
    if(!cut||cut.status!=='preparado')return;
    if(!confirm('¿Cancelar este corte? Los pedidos volverán a estar disponibles para preparar otros cortes.'))return;
    try {await multiWrite(tx=>{
      tx.objectStore('cuts').put({...cut,status:'cancelado',cancelledAt:new Date().toISOString()});
      for(const id of cut.orderIds){const row=state.orders.find(order=>order.id===id);if(row&&row.cutId===cut.id)tx.objectStore('orders').put({...row,cutId:null,updatedAt:new Date().toISOString()});}
    });await readData();notify('Corte cancelado. Los pedidos quedaron disponibles nuevamente.');}
    catch(error){handleError(error);}
  }
  async function updateStorageInfo() {
    const el=$('storage-info');
    if(!navigator.storage){el.textContent='Este navegador no informa el uso de almacenamiento.';return;}
    try {const [estimate,persisted]=await Promise.all([navigator.storage.estimate(),navigator.storage.persisted?.()]);el.textContent=`Almacenamiento utilizado por este sitio: ${((estimate.usage||0)/1048576).toFixed(2)} MB. Persistencia especial: ${persisted?'activada':'no confirmada'}. Evita borrar los datos del sitio y exporta respaldos frecuentes.`;}
    catch(_){el.textContent='Consulta de almacenamiento no disponible. Recuerda descargar respaldos.';}
  }
  async function prepareOffline() {
    const status=$('offline-status');
    if(!('serviceWorker' in navigator)||!window.isSecureContext){
      status.textContent='Instalación offline no disponible en esta dirección. Abre la aplicación mediante HTTPS o localhost. La IP local por HTTP permite probarla, pero no instalar el modo offline.';return;
    }
    try{
      const registration=await navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'});
      const showWaiting=()=>{if(registration.waiting)$('pwa-update').hidden=false;};
      showWaiting();
      registration.addEventListener('updatefound',()=>{
        const worker=registration.installing;
        worker?.addEventListener('statechange',()=>{
          if(worker.state==='installed')showWaiting();
          if(worker.state==='redundant'&&!registration.active)status.textContent='No se completó la descarga offline. Vuelve a abrir con conexión antes de instalar.';
        });
      });
      await navigator.serviceWorker.ready;
      status.textContent='Interfaz disponible sin conexión en este navegador. Comprueba su apertura sin Internet antes de usarla en operación.';
    }catch(error){status.textContent='No se pudo preparar el modo offline. Vuelve a abrir con conexión y comprueba esta sección.';console.warn('Modo offline pendiente:',error);}
  }
  async function exportBackup() {
    try {await readData();const backup={app:'control-pedidos',version:2,exportedAt:new Date().toISOString(),stores:state};downloadFile(`respaldo-pedidos-${TODAY()}.json`,JSON.stringify(backup,null,2),'application/json;charset=utf-8');notify('Respaldo descargado. Guarda otra copia fuera de este dispositivo.');}
    catch(error){handleError(error);}
  }
  function validateBackup(doc) {
    if(doc?.app!=='control-pedidos'||![1,2].includes(doc.version)||!doc.stores)throw new Error('El archivo no es un respaldo compatible de esta aplicación.');
    const data=doc.stores;
    for(const store of STORE_NAMES){
      if(!Array.isArray(data[store]))throw new Error(`Faltan datos de ${store}.`);
      const ids=new Set();
      for(const row of data[store]){if(!row||typeof row.id!=='string'||ids.has(row.id))throw new Error(`Datos duplicados o inválidos en ${store}.`);ids.add(row.id);}
    }
    for(const row of data.clients){
      for(const key of CLIENT_FIELDS)if(row[key]!==undefined&&typeof row[key]!=='string')throw new Error('Los datos del cliente, incluido NIT y NRC, deben ser texto.');
      if(row.requiresCcf!==undefined&&typeof row.requiresCcf!=='boolean')throw new Error('El valor Requiere CCF no es válido.');
    }
    for(const row of data.branches)if(row.address!==undefined&&typeof row.address!=='string')throw new Error('La dirección de sucursal debe ser texto.');
    for(const row of data.products){
      if(!Number.isSafeInteger(row.priceCents)||row.priceCents<0)throw new Error('Un precio registrado no es válido.');
      if(row.occasionalPriceCents!==undefined&&(!Number.isSafeInteger(row.occasionalPriceCents)||row.occasionalPriceCents<0))throw new Error('Un precio ocasional no es válido.');
    }
    const clients=new Set(data.clients.map(row=>row.id)),branches=new Map(data.branches.map(row=>[row.id,row])),products=new Set(data.products.map(row=>row.id)),cuts=new Set(data.cuts.map(row=>row.id)),orders=new Set(data.orders.map(row=>row.id));
    for(const row of data.branches)if(!clients.has(row.clientId))throw new Error('Una sucursal no tiene cliente válido.');
    for(const row of data.orders){
      if(row.kind!==undefined&&!['registered','occasional'].includes(row.kind))throw new Error('Un pedido tiene un tipo desconocido.');
      if(isOccasional(row)){
        if(row.clientId!==null||row.branchId!==null||row.cutId!==null||typeof row.buyerReference!=='string'||row.buyerReference.length>120)throw new Error('Una venta ocasional contiene relaciones o referencia inválidas.');
      }else if(!clients.has(row.clientId)||!branches.has(row.branchId)||branches.get(row.branchId).clientId!==row.clientId)throw new Error('Un pedido tiene cliente o sucursal inválidos.');
      if(row.cutId&&!cuts.has(row.cutId))throw new Error('Un pedido hace referencia a un corte inexistente.');
      if(!Array.isArray(row.lines)||!row.lines.length)throw new Error('Hay pedidos sin líneas válidas.');
      for(const line of row.lines)if(!products.has(line.productId)||!Number.isSafeInteger(line.priceCents)||line.priceCents<0||!Number.isSafeInteger(line.totalCents)||line.totalCents<0||!Number.isFinite(line.quantity)||line.quantity<=0)throw new Error('Un pedido contiene productos o importes inválidos.');
    }
    for(const cut of data.cuts){if(!clients.has(cut.clientId)||!Array.isArray(cut.orderIds)||!cut.orderIds.every(id=>orders.has(id)&&!isOccasional(data.orders.find(row=>row.id===id))))throw new Error('Un corte tiene referencias inválidas o contiene ventas ocasionales.');}
    return data;
  }
  async function importBackup(file) {
    if(!file)return;
    try {
      const data=validateBackup(JSON.parse(await file.text()));
      const counts=`${data.clients.length} clientes, ${data.branches.length} sucursales, ${data.orders.length} pedidos y ${data.cuts.length} cortes`;
      if(!confirm(`Respaldo válido: ${counts}.\n\nADVERTENCIA: restaurar REEMPLAZARÁ todos los registros actuales de este dispositivo. Exporta primero un respaldo de tus datos actuales. ¿Deseas continuar?`))return;
      if(!confirm('Confirma por segunda vez que deseas reemplazar los datos actuales con este respaldo.'))return;
      await multiWrite(tx=>{
        for(const name of STORE_NAMES){const store=tx.objectStore(name);store.clear();data[name].forEach(row=>store.put(row));}
      });
      resetClientForm();resetBranchForm();await readData();activePreview=null;basket=[];renderBasket();$('cut-preview').innerHTML='<div class="empty-state">Datos restaurados. Selecciona un cliente y período.</div>';
      notify(`Respaldo restaurado correctamente: ${counts}.`);
    } catch(error){handleError(error);}
    finally{$('import-backup').value='';}
  }
  function connectEvents() {
    document.querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.page)));
    document.querySelectorAll('[data-navigate]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.navigate)));
    $('quick-order').addEventListener('click',()=>navigate('pedidos'));
    $('order-client').addEventListener('change',changeOrderClient);
    $('cut-client').addEventListener('change',updateCutBranches);
    for(const id of ['filter-from','filter-to','filter-status'])$(id).addEventListener('change',renderOrders);
    $('add-line').addEventListener('click',()=>{try{addLine();}catch(error){handleError(error);}});
    $('client-requiresCcf').addEventListener('change',updateFiscalRequired);
    $('cancel-client-edit').addEventListener('click',resetClientForm);
    $('cancel-branch-edit').addEventListener('click',resetBranchForm);
    $('client-form').addEventListener('submit',async event=>{
      event.preventDefault();const button=event.currentTarget.querySelector('[type=submit]');if(button.disabled)return;
      button.disabled=true;
      try {
        const existing=editingClientId ? state.clients.find(row=>row.id===editingClientId) : null;
        if(editingClientId&&!existing)throw new Error('El cliente ya no está disponible. Cancela la edición y vuelve a seleccionarlo.');
        const fields=Object.fromEntries(CLIENT_FIELDS.map(key=>[key,$('client-'+key).value.trim()]));
        const requiresCcf=$('client-requiresCcf').value==='si';
        if(!fields.name)throw new Error('Ingresa la razón social.');
        if(requiresCcf&&missingFiscal(fields).length)throw new Error('Para CCF completa: '+missingFiscal(fields).join(', ')+'.');
        const normalizeNit=value=>String(value??'').replace(/[-\s]/g,'').toUpperCase();
        if(fields.nit&&state.clients.some(row=>row.id!==editingClientId&&normalizeNit(row.nit)===normalizeNit(fields.nit)))throw new Error('Ya existe un cliente con ese NIT. Agrega una sucursal al cliente existente.');
        await writeStore('clients',{...(existing||{id:uid(),createdAt:new Date().toISOString()}),...fields,requiresCcf,updatedAt:new Date().toISOString()});
        resetClientForm();invalidateFiscalPreview();await readData();notify(existing?'Cliente actualizado correctamente. Se conservaron sus pedidos.':'Cliente guardado correctamente.');
      }catch(error){handleError(error);}finally{button.disabled=false;}
    });
    $('branch-form').addEventListener('submit',async event=>{
      event.preventDefault();const button=event.currentTarget.querySelector('[type=submit]');if(button.disabled)return;
      button.disabled=true;
      try {
        const existing=editingBranchId ? state.branches.find(row=>row.id===editingBranchId) : null;
        if(editingBranchId&&!existing)throw new Error('La sucursal ya no está disponible. Cancela la edición y vuelve a seleccionarla.');
        const clientId=existing?.clientId||$('branch-client').value,name=$('branch-name').value.trim(),alias=$('branch-alias').value.trim(),address=$('branch-address').value.trim();
        if(!state.clients.some(row=>row.id===clientId)||!name||!alias||!address)throw new Error('Completa el cliente, nombre, alias y dirección física de la sucursal.');
        if(state.branches.some(row=>row.id!==editingBranchId&&row.clientId===clientId&&String(row.alias||'').toLowerCase()===alias.toLowerCase()))throw new Error('Ya existe este alias para el cliente.');
        await writeStore('branches',{...(existing||{id:uid(),active:true,createdAt:new Date().toISOString()}),clientId,name,alias,address,updatedAt:new Date().toISOString()});
        resetBranchForm();invalidateFiscalPreview();await readData();notify(existing?'Sucursal actualizada correctamente. Se conservaron sus pedidos.':'Sucursal guardada correctamente.');
      }catch(error){handleError(error);}finally{button.disabled=false;}
    });
    $('product-form').addEventListener('submit',async event=>{
      event.preventDefault();try{
        const name=$('product-name').value.trim(),priceCents=parsePrice($('product-price').value);
        if(!name)throw new Error('Ingresa el producto.');
        if(state.products.some(row=>row.name.toLowerCase()===name.toLowerCase()))throw new Error('Ya existe un producto con este nombre.');
        await writeStore('products',{id:uid(),name,priceCents,unit:$('product-unit').value,active:true,createdAt:new Date().toISOString()});$('product-form').reset();await readData();notify('Producto agregado correctamente.');
      }catch(error){handleError(error);}
    });
    $('order-form').addEventListener('submit',async event=>{
      event.preventDefault();if(savingOrder)return;
      savingOrder=true;const controls=[...$('order-form').querySelectorAll('button[type=submit]')];controls.forEach(button=>button.disabled=true);
      try {
        const occasional=selectedOccasional(),date=$('order-date').value,clientId=occasional?null:$('order-client').value,branchId=occasional?null:$('order-branch').value;
        const buyerReference=occasional?$('order-buyer-reference').value.trim():'';
        if(!date||(!occasional&&(!state.clients.some(row=>row.id===clientId)||!state.branches.some(row=>row.id===branchId&&row.clientId===clientId))))throw new Error('Selecciona fecha, cliente y sucursal, o elige Cliente ocasional.');
        if(buyerReference.length>120)throw new Error('El nombre o referencia admite hasta 120 caracteres.');
        if(!basket.length)throw new Error('Agrega por lo menos un producto y su cantidad.');
        const signature=lines=>JSON.stringify(lines.map(line=>[line.productId,line.quantity,line.priceCents]).sort((a,b)=>a[0].localeCompare(b[0])));
        if(state.orders.some(row=>row.date===date&&isOccasional(row)===occasional&&row.branchId===branchId&&(!occasional||(row.buyerReference||'').toLocaleLowerCase('es')===buyerReference.toLocaleLowerCase('es'))&&row.status!=='cancelado'&&signature(row.lines)===signature(basket))){
          if(!confirm('Se encontró un pedido con la misma fecha, sucursal o referencia del comprador, productos y cantidades. Podría ser un duplicado. ¿Deseas guardarlo de todas maneras?'))return;
        }
        const id=uid(),mode=event.submitter?.value||'guardar';
        const order={id,date,clientId,branchId,...(occasional?{kind:'occasional',buyerReference}:{}),lines:basket.map(line=>({...line})),status:'registrado',cutId:null,note:$('order-note').value.trim(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
        await writeStore('orders',order);basket=[];renderBasket();$('order-note').value='';$('order-buyer-reference').value='';await readData();
        notify(`Pedido #${id.slice(0,8)} guardado correctamente. ${number(orderQty(order))} tortillas · ${money(orderNet(order))} sin IVA.`);
        if(mode==='guardar')navigate('pedidos');else $('order-quantity').focus();
      } catch(error){handleError(error);}finally{savingOrder=false;controls.forEach(button=>button.disabled=false);}
    });
    $('cut-form').addEventListener('submit',event=>{event.preventDefault();try{showCutPreview(previewCut());}catch(error){handleError(error);}});
    $('export-backup').addEventListener('click',exportBackup);
    $('import-backup').addEventListener('change',event=>importBackup(event.target.files[0]));
    $('request-persistence').addEventListener('click',async()=>{
      try{
        const granted=await navigator.storage?.persist?.();await updateStorageInfo();
        notify(granted?'Conservación de datos concedida. Mantén también tus respaldos externos.':'El navegador no concedió conservación especial. Descarga respaldos frecuentes.');
      }catch(error){handleError(error);}
    });
  }
  async function initialize() {
    $('today-label').textContent=new Intl.DateTimeFormat('es-SV',{day:'numeric',month:'short',year:'numeric'}).format(new Date());
    $('order-date').value=TODAY();$('cut-to').value=TODAY();$('cut-from').value=`${TODAY().slice(0,8)}01`;
    function network(){const online=navigator.onLine;$('network-dot').classList.toggle('offline',!online);$('network-label').textContent=online?'Con conexión · datos locales':'Sin conexión · modo local';}
    addEventListener('online',network);addEventListener('offline',network);network();
    try {
      db=await openDatabase();
      db.onversionchange=()=>{db.close();$('storage-warning').hidden=false;$('storage-warning').textContent='La base de datos cambió en otra pestaña. Cierra y abre esta aplicación.';};
      if(!(await queryStore('products')).some(row=>row.id==='tortilla'))await writeStore('products',{id:'tortilla',name:'Tortilla',unit:'unidad',priceCents:6,active:true,createdAt:new Date().toISOString()});
      connectEvents();await readData();renderBasket();
      if(navigator.storage?.persist){try{await navigator.storage.persist();await updateStorageInfo();}catch(_) {}}
      prepareOffline();
    } catch(error) {
      $('storage-warning').hidden=false;
      $('storage-warning').textContent='No se pudo abrir el almacenamiento local. No registres pedidos hasta resolverlo. '+(error.message||'');
      document.querySelectorAll('form button').forEach(button=>button.disabled=true);
      handleError(error);
    }
  }
  initialize();
})();
