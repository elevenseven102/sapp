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

// -------------------- Вспомогательные функции --------------------
// Преобразование canvas в jsfeat.matrix_t (серый)
function canvasToGrayMatrix(canvas) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const mat = new jsfeat.matrix_t(canvas.width, canvas.height, jsfeat.U8C1_t);
  jsfeat.imgproc.grayscale(imageData.data, canvas.width, canvas.height, mat);
  return { mat, imageData };
}

// Поиск углов документа
function findDocumentCorners(grayMat, width, height) {
  // Размытие
  const blurred = new jsfeat.matrix_t(width, height, jsfeat.U8C1_t);
  jsfeat.imgproc.gaussian_blur(grayMat, blurred, 5);

  // Поиск границ (Canny)
  const edges = new jsfeat.matrix_t(width, height, jsfeat.U8C1_t);
  jsfeat.imgproc.canny(blurred, edges, 50, 150);

  // Поиск контуров с помощью contour_finder
  const contourFinder = new jsfeat.imgproc.contour_finder();
  const contours = [];
  contourFinder.findContours(edges, function(poly) {
    // отбираем только замкнутые контуры с 4 углами
    if (poly.length === 4) {
      contours.push(poly.slice()); // копия массива точек
    }
  });

  // Ищем контур с максимальной площадью
  let best = null;
  let maxArea = 0;
  const minArea = width * height * 0.05;

  for (const poly of contours) {
    // jsfeat.imgproc.contourArea ожидает массив точек {x,y} или просто массив?
    // Передадим как массив объектов {x,y}
    const area = jsfeat.imgproc.contourArea(poly);
    if (area > minArea && area > maxArea) {
      maxArea = area;
      best = poly;
    }
  }

  if (!best) return null;

  // Сортируем углы: верхний-левый, верхний-правый, нижний-правый, нижний-левый
  const pts = best.map(p => ({x: p.x, y: p.y}));
  pts.sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const tl = pts[0];
  const br = pts[3];
  const tr = pts[1].x - pts[1].y > pts[2].x - pts[2].y ? pts[1] : pts[2];
  const bl = pts[1] === tr ? pts[2] : pts[1];
  return [tl, tr, br, bl];
}

// Перспективная коррекция с помощью warp_perspective
function warpCanvas(srcCanvas, corners) {
  const srcW = srcCanvas.width;
  const srcH = srcCanvas.height;
  const srcCtx = srcCanvas.getContext('2d');
  const srcImageData = srcCtx.getImageData(0, 0, srcW, srcH);

  // Входное изображение как матрица RGBA
  const srcMat = new jsfeat.matrix_t(srcW, srcH, jsfeat.U8C4_t);
  jsfeat.imgproc.imgDataToMatrix(srcImageData.data, srcMat);

  // Размеры выходного изображения
  function dist(p1, p2) {
    return Math.sqrt((p2.x-p1.x)**2 + (p2.y-p1.y)**2);
  }
  const maxW = Math.round(Math.max(dist(corners[0], corners[1]), dist(corners[2], corners[3])));
  const maxH = Math.round(Math.max(dist(corners[0], corners[3]), dist(corners[1], corners[2])));

  // Исходные и целевые точки
  const srcPts = [
    corners[0].x, corners[0].y,
    corners[1].x, corners[1].y,
    corners[2].x, corners[2].y,
    corners[3].x, corners[3].y
  ];
  const dstPts = [0, 0, maxW-1, 0, maxW-1, maxH-1, 0, maxH-1];

  // Матрица преобразования
  const transform = jsfeat.imgproc.getPerspectiveTransform(srcPts, dstPts);

  // Применяем перспективное преобразование
  const warpedMat = new jsfeat.matrix_t(maxW, maxH, jsfeat.U8C4_t);
  jsfeat.imgproc.warp_perspective(srcMat, warpedMat, transform);

  // Результат на canvas
  const outCanvas = document.createElement('canvas');
  outCanvas.width = maxW;
  outCanvas.height = maxH;
  const outCtx = outCanvas.getContext('2d');
  const outImageData = outCtx.createImageData(maxW, maxH);
  jsfeat.imgproc.matrixToImgData(warpedMat, outImageData.data);
  outCtx.putImageData(outImageData, 0, 0);

  return outCanvas;
}

// Эффект сканера (ч/б + автоуровни)
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

  // Автоуровни: отсекаем 2% с краёв
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

// -------------------- Главный процесс сканирования --------------------
async function scanFromImage(imgElement) {
  statusDiv.textContent = 'Обработка...';
  outputCanvas.style.display = 'none';
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  // Кладём изображение на временный canvas
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = imgElement.naturalWidth || imgElement.videoWidth || imgElement.width;
  srcCanvas.height = imgElement.naturalHeight || imgElement.videoHeight || imgElement.height;
  const srcCtx = srcCanvas.getContext('2d');
  srcCtx.drawImage(imgElement, 0, 0, srcCanvas.width, srcCanvas.height);

  // Получаем серую матрицу и ищем углы
  const { mat: grayMat } = canvasToGrayMatrix(srcCanvas);
  const corners = findDocumentCorners(grayMat, srcCanvas.width, srcCanvas.height);

  let processedCanvas;
  if (corners) {
    processedCanvas = warpCanvas(srcCanvas, corners);

    // Рисуем контур на overlay (масштабируем)
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
    processedCanvas = srcCanvas; // fallback, если документ не найден
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
  overlay.style.display = 'none';
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