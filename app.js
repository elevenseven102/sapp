const video = document.getElementById('video');
const overlayCanvas = document.getElementById('overlayCanvas');
const overlayCtx = overlayCanvas.getContext('2d');
const outputCanvas = document.getElementById('outputCanvas');
const outputCtx = outputCanvas.getContext('2d');
const captureBtn = document.getElementById('captureBtn');
const fileInput = document.getElementById('fileInput');
const downloadPdfBtn = document.getElementById('downloadPdfBtn');
const statusDiv = document.getElementById('status');

let stream = null;
let scannedImageDataUrl = null;
let opencvReady = false;
let scanner = null; // экземпляр JScanify

// -------------------- Ожидание загрузки OpenCV --------------------
function checkOpenCV() {
  if (typeof cv !== 'undefined' && cv.Mat) {
    opencvReady = true;
    scanner = new jscanify.JScanify();
    captureBtn.disabled = false;
    statusDiv.textContent = 'Готово. Наведите камеру на документ.';
  } else {
    setTimeout(checkOpenCV, 200);
  }
}

// Если скрипт OpenCV загружен и уже инициализирован
if (typeof cv !== 'undefined' && cv.Mat) {
  checkOpenCV();
} else {
  // Ждём onload скрипта или глобальную инициализацию
  window.addEventListener('load', () => {
    // Иногда OpenCV ещё не готов, поэтому проверяем циклически
    checkOpenCV();
  });
}

// -------------------- Камера --------------------
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    resizeOverlay();
    if (!opencvReady) statusDiv.textContent = 'Загрузка OpenCV...';
  } catch (e) {
    statusDiv.textContent = 'Ошибка камеры: ' + e.message;
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
}

// -------------------- Эффект сканера (ч/б + автоуровни) --------------------
function applyScannerEffect(canvas) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;

  // В серый + гистограмма
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
    d[i] = d[i+1] = d[i+2] = gray;
    hist[Math.round(gray)]++;
  }

  // Автоуровни: отсекаем по 2% с краёв
  let low = 0, high = 255;
  let sum = 0;
  const total = d.length / 4;
  for (let i = 0; i < 256; i++) {
    sum += hist[i];
    if (sum < total * 0.02) low = i;
    if (sum > total * 0.98) { high = i; break; }
  }
  const range = high - low || 1;
  for (let i = 0; i < d.length; i += 4) {
    let val = d[i];
    val = ((val - low) / range) * 255;
    val = Math.max(0, Math.min(255, val));
    d[i] = d[i+1] = d[i+2] = val;
  }
  ctx.putImageData(imageData, 0, 0);
}

// -------------------- Сканирование --------------------
function processImage(sourceCanvas) {
  if (!opencvReady || !scanner) {
    statusDiv.textContent = 'Библиотеки ещё не загружены.';
    return;
  }
  statusDiv.textContent = 'Обработка...';

  // Рисуем на overlay контур (опционально, но наглядно)
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  const paperCanvas = scanner.highlightPaper(sourceCanvas, { color: '#00ff00' });
  if (paperCanvas) {
    overlayCtx.drawImage(paperCanvas, 0, 0, overlayCanvas.width, overlayCanvas.height);
  }

  // Извлекаем документ с коррекцией перспективы
  const resultCanvas = scanner.extractPaper(sourceCanvas, { color: '#ffffff', quality: 1.0 });
  let processedCanvas;
  if (resultCanvas) {
    processedCanvas = resultCanvas;
  } else {
    processedCanvas = sourceCanvas; // если не нашли – берём всё изображение
    statusDiv.textContent = 'Документ не найден. Использовано всё изображение.';
  }

  // Применяем сканерный эффект
  applyScannerEffect(processedCanvas);

  // Показываем результат
  outputCanvas.width = processedCanvas.width;
  outputCanvas.height = processedCanvas.height;
  outputCtx.drawImage(processedCanvas, 0, 0);
  outputCanvas.style.display = 'block';
  video.style.display = 'none';
  overlayCanvas.style.display = 'none';
  scannedImageDataUrl = outputCanvas.toDataURL('image/png');
  downloadPdfBtn.disabled = false;
  statusDiv.textContent = 'Готово! Можно сохранить PDF.';
}

// -------------------- Захват с камеры --------------------
captureBtn.addEventListener('click', () => {
  if (!video.videoWidth) return;
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = video.videoWidth;
  tempCanvas.height = video.videoHeight;
  tempCanvas.getContext('2d').drawImage(video, 0, 0);
  processImage(tempCanvas);
});

// -------------------- Загрузка из галереи --------------------
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = img.width;
    tempCanvas.height = img.height;
    tempCanvas.getContext('2d').drawImage(img, 0, 0);
    processImage(tempCanvas);
  };
  img.src = URL.createObjectURL(file);
});

// -------------------- Сохранение в PDF --------------------
downloadPdfBtn.addEventListener('click', () => {
  if (!scannedImageDataUrl) return;
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({
    orientation: outputCanvas.width > outputCanvas.height ? 'landscape' : 'portrait',
    unit: 'px',
    format: [outputCanvas.width, outputCanvas.height]
  });
  pdf.addImage(scannedImageDataUrl, 'PNG', 0, 0, outputCanvas.width, outputCanvas.height);
  pdf.save('scan.pdf');
});

// -------------------- Подгонка размеров overlay --------------------
function resizeOverlay() {
  const rect = video.getBoundingClientRect();
  overlayCanvas.width = rect.width;
  overlayCanvas.height = rect.height;
}
window.addEventListener('resize', resizeOverlay);
video.addEventListener('loadedmetadata', resizeOverlay);

// -------------------- Старт --------------------
startCamera();