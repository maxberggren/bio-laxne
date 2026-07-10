const screeningsEl = document.querySelector('#screenings');
const bookingDialog = document.querySelector('#booking-dialog');
const bookingForm = document.querySelector('#booking-form');
const ticketDialog = document.querySelector('#ticket-dialog');
const savedTicketsDialog = document.querySelector('#saved-tickets-dialog');
const installCard = document.querySelector('#install-card');
const installButton = document.querySelector('#install-button');
const notifyButton = document.querySelector('#notify-button');
let screenings = [];
let recoveredTickets = [];
let deferredInstall;

async function loadScreenings() {
  try {
    const response = await fetch('/api/screenings');
    if (!response.ok) throw new Error();
    screenings = await response.json();
    renderScreenings();
  } catch {
    screeningsEl.innerHTML = '<p class="empty-programme">Programmet gömmer sig bakom ridån just nu. Försök snart igen.</p>';
  }
}

function renderScreenings() {
  if (!screenings.length) {
    screeningsEl.innerHTML = '<p class="empty-programme">Inga visningar är annonserade ännu. Installera appen så säger vi till när ridån går upp.</p>';
    return;
  }
  screeningsEl.innerHTML = screenings.map((screening) => {
    const remaining = 4 - screening.bookedSeats.length;
    return `<article class="film-card">
      <div class="poster-wrap">
        <img class="poster" src="${escapeHtml(screening.posterUrl)}" alt="Affisch för ${escapeHtml(screening.title)}">
        <span class="availability">${remaining ? `${remaining} ${remaining === 1 ? 'plats' : 'platser'} kvar` : 'Fullsatt'}</span>
      </div>
      <div class="film-meta"><time datetime="${screening.startsAt}">${formatDateTime(screening.startsAt)}</time><span>${screening.runtime} min · ${priceLabel(screening.price)}</span></div>
      <h3>${escapeHtml(screening.title)}</h3>
      <p class="synopsis">${escapeHtml(screening.synopsis)}</p>
      <p class="seat-label">Tryck på din stol</p>
      <div class="seats" aria-label="Lediga stolar">
        ${[1, 2, 3, 4].map((seat) => `<button class="seat" data-screening="${screening.id}" data-seat="${seat}" ${screening.bookedSeats.includes(seat) ? 'disabled aria-label="Stol ' + seat + ', bokad"' : 'aria-label="Boka stol ' + seat + '"'}>${seat}</button>`).join('')}
      </div>
    </article>`;
  }).join('');
}

screeningsEl.addEventListener('click', (event) => {
  const button = event.target.closest('.seat:not([disabled])');
  if (!button) return;
  const screening = screenings.find((item) => item.id === Number(button.dataset.screening));
  bookingForm.reset();
  bookingForm.screeningId.value = screening.id;
  bookingForm.seat.value = button.dataset.seat;
  document.querySelector('#booking-summary').innerHTML = `<p class="eyebrow">En av fyra</p><h2>${escapeHtml(screening.title)}</h2><p class="booking-details">${formatDateTime(screening.startsAt)} · <b>Stol ${button.dataset.seat}</b> · ${priceLabel(screening.price)}<br>Eventuellt biljettpris betalas med Swish i entrén.</p>`;
  bookingDialog.showModal();
  setTimeout(() => bookingForm.guestName.focus(), 50);
});

bookingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = bookingForm.querySelector('button[type="submit"]');
  const errorEl = bookingForm.querySelector('.form-error');
  submit.disabled = true;
  errorEl.textContent = '';
  try {
    const response = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        screeningId: Number(bookingForm.screeningId.value),
        seat: Number(bookingForm.seat.value),
        guestName: bookingForm.guestName.value,
        subscriptionEndpoint: localStorage.getItem('bioPushEndpoint')
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const savedTickets = getSavedTokens();
    localStorage.setItem('bioTickets', JSON.stringify([...savedTickets, result.ticketToken].slice(-20)));
    bookingDialog.close();
    await drawTicket(result);
    ticketDialog.showModal();
    await loadScreenings();
  } catch (error) {
    errorEl.textContent = error.message || 'Bokningen gick inte igenom.';
  } finally {
    submit.disabled = false;
  }
});

async function drawTicket(ticket) {
  const canvas = document.querySelector('#ticket-canvas');
  const context = canvas.getContext('2d');
  const image = new Image();
  image.src = ticket.qrDataUrl;
  await image.decode();

  context.fillStyle = '#ead5aa';
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 3600; i += 1) {
    const alpha = Math.random() * 0.08;
    context.fillStyle = `rgba(82,45,25,${alpha})`;
    context.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, Math.random() * 3 + 1, Math.random() * 3 + 1);
  }
  context.strokeStyle = '#71303a';
  context.lineWidth = 7;
  context.strokeRect(30, 30, 740, 1220);
  context.setLineDash([12, 10]);
  context.lineWidth = 2;
  context.strokeRect(48, 48, 704, 1184);
  context.setLineDash([]);

  context.textAlign = 'center';
  context.fillStyle = '#681b25';
  context.font = 'bold 34px Georgia';
  context.fillText('✦  BIO LAXNE  ✦', 400, 105);
  context.fillStyle = '#2b1710';
  context.font = 'italic 28px Georgia';
  context.fillText('Fyra stolar. Oändliga världar.', 400, 150);
  context.fillRect(90, 182, 620, 2);

  fitText(context, ticket.screening.title.toUpperCase(), 400, 250, 60, 650);
  context.fillStyle = '#704d3a';
  context.font = 'bold 23px Arial';
  context.fillText(formatDateTime(ticket.screening.startsAt), 400, 310);
  context.font = 'bold 18px Arial';
  context.fillStyle = '#681b25';
  context.fillText(ticket.screening.price === null || ticket.screening.price === undefined ? 'FRI ENTRÉ' : `${ticket.screening.price} KR · BETALAS MED SWISH I ENTRÉN`, 400, 337);

  context.fillStyle = '#681b25';
  context.fillRect(75, 348, 650, 120);
  context.fillStyle = '#f4e7cc';
  context.font = '16px Arial';
  context.fillText('GÄST', 255, 382);
  context.fillText('STOL', 565, 382);
  context.font = 'bold 31px Georgia';
  context.fillText(ticket.guestName, 255, 426);
  context.font = 'bold 55px Georgia';
  context.fillText(String(ticket.seat), 565, 438);

  context.fillStyle = '#fffaf0';
  context.fillRect(160, 515, 480, 480);
  context.drawImage(image, 175, 530, 450, 450);
  context.fillStyle = '#2b1710';
  context.font = 'bold 20px Arial';
  context.fillText('VISA DENNA KOD I DÖRREN', 400, 1040);
  context.font = 'italic 23px Georgia';
  context.fillText('Spara biljetten - den är din nyckel in i mörkret.', 400, 1095);
  context.font = '17px Arial';
  context.fillStyle = '#76513b';
  context.fillText('ENDAST GILTIG EN GÅNG · SPARAD I MINA BILJETTER', 400, 1170);

  const url = canvas.toDataURL('image/png');
  document.querySelector('#download-ticket').href = url;
  const shareButton = document.querySelector('#share-ticket');
  if (navigator.share && navigator.canShare) {
    shareButton.classList.remove('hidden');
    shareButton.onclick = () => canvas.toBlob(async (blob) => {
      const file = new File([blob], 'bio-laxne-biljett.png', { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: 'Min Bio Laxne-biljett' });
    });
  }
}

function fitText(context, text, x, y, size, maxWidth) {
  do {
    context.font = `bold ${size--}px Georgia`;
  } while (context.measureText(text).width > maxWidth && size > 24);
  context.fillStyle = '#2b1710';
  context.fillText(text, x, y);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function priceLabel(price) {
  return price === null || price === undefined ? 'fri entré' : `${price} kr`;
}

function formatDateTime(value) {
  const date = new Date(value);
  const parts = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')];
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${parts.join('-')} ${time}`;
}

function getSavedTokens() {
  try {
    const tokens = JSON.parse(localStorage.getItem('bioTickets') || '[]');
    return Array.isArray(tokens) ? tokens.filter((token) => typeof token === 'string') : [];
  } catch {
    return [];
  }
}

document.querySelector('#saved-tickets-button').addEventListener('click', async () => {
  const list = document.querySelector('#saved-tickets-list');
  const tokens = getSavedTokens();
  savedTicketsDialog.showModal();
  if (!tokens.length) {
    list.innerHTML = '<p class="saved-empty">Inga biljetter är sparade på den här enheten ännu.</p>';
    return;
  }
  list.innerHTML = '<p class="saved-empty">Hämtar biljetter...</p>';
  try {
    const response = await fetch('/api/tickets/recover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tokens }) });
    if (!response.ok) throw new Error();
    recoveredTickets = await response.json();
    list.innerHTML = recoveredTickets.map((ticket, index) => `<article class="saved-ticket">
      <strong>${escapeHtml(ticket.screening.title)}</strong>
      <span>${formatDateTime(ticket.screening.startsAt)} · stol ${ticket.seat} · ${priceLabel(ticket.screening.price)}</span>
      <button class="button button-small" data-ticket-index="${index}">Visa igen</button>
    </article>`).join('') || '<p class="saved-empty">Biljetterna kunde inte längre hittas.</p>';
  } catch {
    list.innerHTML = '<p class="saved-empty">Biljetterna kunde inte hämtas just nu. Försök igen.</p>';
  }
});

document.querySelector('#saved-tickets-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-ticket-index]');
  if (!button) return;
  await drawTicket(recoveredTickets[Number(button.dataset.ticketIndex)]);
  savedTicketsDialog.close();
  ticketDialog.showModal();
});

document.querySelectorAll('.dialog-close').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
}));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (standalone || localStorage.getItem('bioInstalled')) showNotifyStep();
if (localStorage.getItem('hideInstall') === 'true' || Notification.permission === 'granted') installCard.classList.add('hidden');

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event;
});

window.addEventListener('appinstalled', () => {
  localStorage.setItem('bioInstalled', 'true');
  deferredInstall = null;
  showNotifyStep();
});

installButton.addEventListener('click', async () => {
  if (!deferredInstall) {
    document.querySelector('#install-help').showModal();
    return;
  }
  await deferredInstall.prompt();
  const choice = await deferredInstall.userChoice;
  if (choice.outcome === 'accepted') {
    localStorage.setItem('bioInstalled', 'true');
    showNotifyStep();
  }
});

function showNotifyStep() {
  installButton.classList.add('hidden');
  notifyButton.classList.remove('hidden');
  installCard.querySelector('strong').textContent = 'Missa aldrig ridån';
  installCard.querySelector('p').textContent = 'Slå på notiser för nya filmer och en påminnelse före din visning.';
}

notifyButton.addEventListener('click', async () => {
  notifyButton.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notiser tilläts inte. Du kan ändra det i webbläsarens inställningar.');
    const registration = await navigator.serviceWorker.ready;
    const { publicKey } = await fetch('/api/push/public-key').then((response) => response.json());
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64Key(publicKey) });
    const response = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription }) });
    const result = await response.json();
    localStorage.setItem('bioPushEndpoint', result.endpoint);
    const tokens = getSavedTokens();
    if (tokens.length) {
      await fetch('/api/push/link-bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: result.endpoint, tokens }) });
    }
    installCard.classList.add('hidden');
  } catch (error) {
    alert(error.message);
  } finally {
    notifyButton.disabled = false;
  }
});

installCard.querySelector('.install-close').addEventListener('click', () => {
  localStorage.setItem('hideInstall', 'true');
  installCard.classList.add('hidden');
});

function base64Key(value) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

loadScreenings();
