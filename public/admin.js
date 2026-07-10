const loginPanel = document.querySelector('#login-panel');
const dashboard = document.querySelector('#dashboard');
const loginForm = document.querySelector('#login-form');
const screeningForm = document.querySelector('#screening-form');
const scanner = document.querySelector('#scanner');
const video = document.querySelector('#scanner-video');
const scanResult = document.querySelector('#scan-result');
let scanTimer;
let stream;

setScreeningDefaults();

async function checkSession() {
  const { authenticated } = await fetch('/api/admin/session').then((response) => response.json());
  if (authenticated) showDashboard();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = loginForm.querySelector('.form-error');
  error.textContent = '';
  const response = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: loginForm.password.value }) });
  const result = await response.json();
  if (!response.ok) return void (error.textContent = result.error);
  loginForm.reset();
  showDashboard();
});

function showDashboard() {
  loginPanel.classList.add('hidden');
  dashboard.classList.remove('hidden');
  loadAdminScreenings();
}

document.querySelector('#logout').addEventListener('click', async () => {
  stopScanner();
  await fetch('/api/admin/logout', { method: 'POST' });
  dashboard.classList.add('hidden');
  loginPanel.classList.remove('hidden');
});

screeningForm.poster.addEventListener('change', () => {
  document.querySelector('#poster-name').textContent = screeningForm.poster.files[0]?.name || 'Välj bild, max 8 MB';
});

screeningForm.screeningDate.addEventListener('input', (event) => {
  const digits = event.target.value.replace(/\D/g, '').slice(0, 8);
  event.target.value = [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8)].filter(Boolean).join('-');
});

screeningForm.screeningTime.addEventListener('input', (event) => {
  const digits = event.target.value.replace(/\D/g, '').slice(0, 4);
  event.target.value = digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
});

screeningForm.screeningTime.addEventListener('blur', (event) => {
  const digits = event.target.value.replace(/\D/g, '');
  if (digits.length === 1) event.target.value = `0${digits}:00`;
  if (digits.length === 2) event.target.value = `${digits}:00`;
  if (digits.length === 3) event.target.value = `0${digits[0]}:${digits.slice(1)}`;
});

screeningForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = screeningForm.querySelector('button[type="submit"]');
  const error = screeningForm.querySelector('.form-error');
  button.disabled = true;
  error.textContent = '';
  try {
    const dateParts = screeningForm.screeningDate.value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const timeParts = screeningForm.screeningTime.value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!dateParts || !timeParts) throw new Error('Ange datum som ÅÅÅÅ-MM-DD och tid som TT:mm, exempelvis 19:00.');
    const startsAt = new Date(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3]), Number(timeParts[1]), Number(timeParts[2]));
    if (startsAt.getFullYear() !== Number(dateParts[1]) || startsAt.getMonth() !== Number(dateParts[2]) - 1 || startsAt.getDate() !== Number(dateParts[3])) {
      throw new Error('Datumet finns inte. Använd formatet ÅÅÅÅ-MM-DD.');
    }
    const data = new FormData(screeningForm);
    data.delete('screeningDate');
    data.delete('screeningTime');
    data.set('startsAt', startsAt.toISOString());
    const response = await fetch('/api/admin/screenings', { method: 'POST', body: data });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    screeningForm.reset();
    setScreeningDefaults();
    document.querySelector('#poster-name').textContent = 'Välj bild, max 8 MB';
    await loadAdminScreenings();
  } catch (failure) {
    error.textContent = failure.message;
  } finally {
    button.disabled = false;
  }
});

function setScreeningDefaults() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const year = tomorrow.getFullYear();
  const month = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const day = String(tomorrow.getDate()).padStart(2, '0');
  screeningForm.screeningDate.value = `${year}-${month}-${day}`;
  screeningForm.screeningTime.value = '19:00';
  screeningForm.runtime.value = 90;
}

async function loadAdminScreenings() {
  const response = await fetch('/api/admin/screenings');
  if (response.status === 401) return;
  const screenings = await response.json();
  document.querySelector('#admin-screenings').innerHTML = screenings.map((item) => `<article class="admin-screening">
    <img src="${escapeHtml(item.posterUrl)}" alt="">
    <div><h3>${escapeHtml(item.title)}</h3><p>${formatDateTime(item.startsAt)} · ${item.runtime} min${item.price === null ? ' · fri entré' : ` · ${item.price} kr`}</p></div>
    <div class="screening-actions"><span class="seat-count">${item.bookedSeats.length} av 4 bokade</span><button class="delete-screening" data-screening-id="${item.id}" data-screening-title="${escapeHtml(item.title)}">Ta bort</button></div>
  </article>`).join('') || '<p>Inga visningar ännu.</p>';
}

document.querySelector('#admin-screenings').addEventListener('click', async (event) => {
  const button = event.target.closest('.delete-screening');
  if (!button) return;
  const confirmed = confirm(`Ta bort ${button.dataset.screeningTitle}? Alla bokningar till visningen försvinner också.`);
  if (!confirmed) return;
  button.disabled = true;
  const response = await fetch(`/api/admin/screenings/${button.dataset.screeningId}`, { method: 'DELETE' });
  const result = await response.json();
  if (!response.ok) {
    button.disabled = false;
    return alert(result.error || 'Visningen kunde inte tas bort.');
  }
  await loadAdminScreenings();
});

function formatDateTime(value) {
  const date = new Date(value);
  const parts = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')];
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${parts.join('-')} ${time}`;
}

document.querySelector('#start-scan').addEventListener('click', async () => {
  if (stream) return stopScanner();
  scanResult.classList.add('hidden');
  try {
    if (!('BarcodeDetector' in window)) throw new Error('Den här webbläsaren saknar QR-skanner. Använd Chrome eller klistra in koden nedan.');
    const supported = await BarcodeDetector.getSupportedFormats();
    if (!supported.includes('qr_code')) throw new Error('QR-skanning stöds inte på den här enheten.');
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream;
    await video.play();
    scanner.classList.add('active');
    document.querySelector('#start-scan').textContent = 'Stoppa kameran';
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    scanTimer = setInterval(async () => {
      try {
        const codes = await detector.detect(video);
        if (codes[0]?.rawValue) {
          stopScanner();
          await validateTicket(codes[0].rawValue);
        }
      } catch { /* The video may be between frames. */ }
    }, 350);
  } catch (error) {
    showScanResult('invalid', 'Kameran kunde inte starta', error.message);
  }
});

document.querySelector('#manual-scan').addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = event.currentTarget.token.value.trim();
  if (token) await validateTicket(token);
});

function stopScanner() {
  clearInterval(scanTimer);
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  scanner.classList.remove('active');
  document.querySelector('#start-scan').textContent = 'Starta kameran';
}

async function validateTicket(token) {
  const response = await fetch('/api/admin/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const result = await response.json();
  const detail = result.booking ? `${result.booking.guestName} · ${result.booking.title} · stol ${result.booking.seat}` : result.message;
  showScanResult(result.status || 'invalid', result.message, detail);
}

function showScanResult(status, title, detail) {
  scanResult.className = `scan-result ${status}`;
  scanResult.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
}

document.querySelector('#admin-notify').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Pushnotiser stöds inte här.');
    await navigator.serviceWorker.register('/sw.js');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notiser tilläts inte.');
    const registration = await navigator.serviceWorker.ready;
    const { publicKey } = await fetch('/api/push/public-key').then((response) => response.json());
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64Key(publicKey) });
    const response = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription, role: 'admin' }) });
    if (!response.ok) throw new Error('Notisen kunde inte aktiveras.');
    button.textContent = 'Bokningsnotiser är på';
  } catch (error) {
    alert(error.message);
    button.disabled = false;
  }
});

function base64Key(value) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

checkSession();
