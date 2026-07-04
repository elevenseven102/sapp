// DOM элементы
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');
const outputCanvas = document.getElementById('outputCanvas');
const outputCtx = outputCanvas.getContext('2d');
const captureBtn = document.getElementById('captureBtn');
const fileInput = document.getElementById('fileInput');
const downloadPdfBtn = document.getElementById('downloadPdfBtn');
const statusDiv = document.getElementById('status');

let stream = null;
let scannedImageDataUrl = null;

// -------------------- Камера --------------------
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    statusDiv.textContent = 'Готово. Наведите на документ.';
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

// -------------------- JSFeat: обнаружение документа --------------------
function findDocumentCorners(imageData) {
  const { width, height, data } = imageData;

  // 1. Переводим в серый
  const gray = new jsfeat.matrix_t(width, height, jsfeat.U8C1_t);
  jsfeat.imgproc.grayscale(data, width, height, gray);

  // 2. Размытие
  const blurred = new jsfeat.matrix_t(width, height, jsfeat.U8C1_t);
  jsfeat.imgproc.gaussian_blur(gray, blurred, 5);

  // 3. Поиск границ (Canny)
  const edges = new jsfeat.matrix_t(width, height, jsfeat.U8C1_t);
  jsfeat.imgproc.canny(blurred, edges, 50, 150);

  // 4. Ищем контуры
  const contours = [];
  jsfeat.imgproc.findContours(edges, contours, (ctx, x, y, w, h) => {
    // Игнорируем слишком маленькие области
  });

  // 5. Ищем самый большой четырёхугольник
  let bestContour = null;
  let maxArea = 0;
  const minArea = width * height * 0.05; // минимум 5% площади кадра

  for (let i = 0; i < contours.length; i++) {
    const cnt = contours[i];
    // Аппроксимируем контур полигоном
    const poly = jsfeat.imgproc.approxPolyDP(cnt, 0.02 * jsfeat.imgproc.arcLength(cnt, true), true);
    if (poly.length === 4) {
      const area = jsfeat.imgproc.contourArea(poly);
      if (area > minArea && area > maxArea) {
        maxArea = area;
        bestContour = poly;
      }
    }
  }

  if (!bestContour) {
    statusDiv.textContent = 'Документ не найден, используем всё изображение.';
    return null;
  }

  // Приводим углы к формату [{x,y},...] и сортируем
  let corners = bestContour.map(p => ({x: p.x, y: p.y}));
  corners.sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const tl = corners[0];
  const br = corners[3];
  const tr = corners[1].x - corners[1].y > corners[2].x - corners[2].y ? corners[1] : corners[2];
  const bl = corners[1] === tr ? corners[2] : corners[1];

  return [tl, tr, br, bl];
}

// Коррекция перспективы и улучшение
function processWithCorners(sourceCanvas, corners) {
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  const srcCtx = sourceCanvas.getContext('2d');
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH);

  // Вычисляем размеры выходного изображения
  function dist(p1, p2) {
    return Math.sqrt((p2.x-p1.x)**2 + (p2.y-p1.y)**2);
  }
  const maxW = Math.round(Math.max(dist(corners[0], corners[1]), dist(corners[2], corners[3])));
  const maxH = Math.round(Math.max(dist(corners[0], corners[3]), dist(corners[1], corners[2])));

  // Создаём пустое выходное изображение
  const outCanvas = document.createElement('canvas');
  outCanvas.width = maxW;
  outCanvas.height = maxH;
  const outCtx = outCanvas.getContext('2d');
  const outData = outCtx.createImageData(maxW, maxH);

  // Координаты углов исходного и целевого
  const srcPts = [corners[0].x, corners[0].y, corners[1].x, corners[1].y,
                  corners[2].x, corners[2].y, corners[3].x, corners[3].y];
  const dstPts = [0, 0, maxW-1, 0, maxW-1, maxH-1, 0, maxH-1];

  // Получаем матрицу перспективного преобразования через jsfeat
  const transform = jsfeat.imgproc.getPerspectiveTransform(srcPts, dstPts);

  // Применяем перспективное преобразование вручную (обратное проецирование)
  for (let y = 0; y < maxH; y++) {
    for (let x = 0; x < maxW; x++) {
      // Применяем матрицу к точке (x, y) чтобы найти исходную позицию
      const w = transform[6]*x + transform[7]*y + transform[8];
      const srcX = (transform[0]*x + transform[1]*y + transform[2]) / w;
      const srcY = (transform[3]*x + transform[4]*y + transform[5]) / w;

      if (srcX >= 0 && srcX < srcW && srcY >= 0 && srcY < srcH) {
        const ix = Math.floor(srcX);
        const iy = Math.floor(srcY);
        const idx = (iy * srcW + ix) * 4;
        const outIdx = (y * maxW + x) * 4;
        outData.data[outIdx] = srcData.data[idx];
        outData.data[outIdx+1] = srcData.data[idx+1];
        outData.data[outIdx+2] = srcData.data[idx+2];
        outData.data[outIdx+3] = 255;
      }
    }
  }
  outCtx.putImageData(outData, 0, 0);
  return outCanvas;
}

// Эффект сканера (ч/б + автоуровни)
function applyScannerEffect(canvas) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;

  // Сначала в серый и собираем гистограмму
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
    d[i] = d[i+1] = d[i+2] = gray;
    hist[Math.round(gray)]++;
  }

  // Автоуровни: отсекаем 2% тёмных и 2% светлых пикселей
  let low = 0, high = 255;
  let sum = 0;
  const total = (d.length / 4);
  for (let i = 0; i < 256; i++) {
    sum += hist[i];
    if (sum < total * 0.02) low = i;
    if (sum > total * 0.98) { high = i; break; }
  }

  // Применяем растяжение
  const range = high - low || 1;
  for (let i = 0; i < d.length; i += 4) {
    let val = d[i];
    val = ((val - low) / range) * 255;
    val = Math.max(0, Math.min(255, val));
    d[i] = d[i+1] = d[i+2] = val;
  }
  ctx.putImageData(imageData, 0, 0);
}

// -------------------- Главный процесс сканирования --------------------
async function scanFromImage(imgElement) {
  statusDiv.textContent = 'Обработка...';
  outputCanvas.style.display = 'none';
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  // Кладём изображение на временный canvas (уже в натуральную величину)
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = imgElement.naturalWidth || imgElement.videoWidth || imgElement.width;
  srcCanvas.height = imgElement.naturalHeight || imgElement.videoHeight || imgElement.height;
  const srcCtx = srcCanvas.getContext('2d');
  srcCtx.drawImage(imgElement, 0, 0, srcCanvas.width, srcCanvas.height);

  // Получаем ImageData для JSFeat
  const imageData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);

  // Ищем углы документа
  const corners = findDocumentCorners(imageData);
  let processedCanvas;

  if (corners) {
    processedCanvas = processWithCorners(srcCanvas, corners);
    // Рисуем найденные углы на overlay (для визуальной обратной связи)
    const scaleX = overlay.width / srcCanvas.width;
    const scaleY = overlay.height / srcCanvas.height;
    overlayCtx.strokeStyle = '#00ff00';
    overlayCtx.lineWidth = 2;
    overlayCtx.beginPath();
    overlayCtx.moveTo(corners[0].x * scaleX, corners[0].y * scaleY);
    for (let i = 1; i < 4; i++) overlayCtx.lineTo(corners[i].x * scaleX, corners[i].y * scaleY);
    overlayCtx.closePath();
    overlayCtx.stroke();
  } else {
    processedCanvas = srcCanvas; // fallback
  }

  // Применяем сканерный эффект
  applyScannerEffect(processedCanvas);

  // Показываем результат
  outputCanvas.width = processedCanvas.width;
  outputCanvas.height = processedCanvas.height;
  outputCtx.drawImage(processedCanvas, 0, 0);
  outputCanvas.style.display = 'block';
  video.style.display = 'none';
  overlay.style.display = 'none';
  scannedImageDataUrl = outputCanvas.toDataURL('image/png');
  downloadPdfBtn.disabled = false;
  statusDiv.textContent = 'Готово! Можно сохранить PDF.';
}

// -------------------- Захват с камеры --------------------
captureBtn.addEventListener('click', () => {
  if (!video.videoWidth) return;
  // Создаём canvas с размерами видео
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = video.videoWidth;
  tempCanvas.height = video.videoHeight;
  tempCanvas.getContext('2d').drawImage(video, 0, 0);
  scanFromImage(tempCanvas);
});

// -------------------- Загрузка из галереи --------------------
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => scanFromImage(img);
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

// -------------------- Подгонка размеров overlay под видео --------------------
function resizeOverlay() {
  const rect = video.getBoundingClientRect();
  overlay.width = rect.width;
  overlay.height = rect.height;
}
window.addEventListener('resize', resizeOverlay);
video.addEventListener('loadedmetadata', resizeOverlay);

// -------------------- Инициализация --------------------
startCamera();