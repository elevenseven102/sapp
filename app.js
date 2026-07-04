// DOM элементы
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const outputCanvas = document.getElementById('outputCanvas');
const captureBtn = document.getElementById('captureBtn');
const fileInput = document.getElementById('fileInput');
const downloadPdfBtn = document.getElementById('downloadPdfBtn');
const statusDiv = document.getElementById('status');

let stream = null;
let opencvReady = false;
let scannedImageDataUrl = null;   // результат в формате dataURL

// -------------------- Инициализация камеры --------------------
async function startCamera() {
  if (stream) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    statusDiv.textContent = 'Камера запущена. Нажмите «Сканировать».';
  } catch (err) {
    statusDiv.textContent = 'Ошибка доступа к камере: ' + err.message;
  }
}

// Остановка камеры
function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
}

// -------------------- OpenCV: ожидание загрузки --------------------
function onOpenCvReady() {
  opencvReady = true;
  statusDiv.textContent = 'OpenCV готов. Можно сканировать.';
}
// Привяжем callback, когда скрипт загрузится (если загрузился до выполнения скрипта, можно проверить)
if (typeof cv !== 'undefined') {
  onOpenCvReady();
} else {
  document.getElementById('opencvScript').addEventListener('load', onOpenCvReady);
}

// -------------------- Автоопределение документа и коррекция --------------------
function detectAndCropDocument(imageElement) {
  if (!opencvReady) throw new Error('OpenCV ещё не загружен');

  // Читаем изображение в матрицу OpenCV
  let src = cv.imread(imageElement);
  let gray = new cv.Mat();
  let blurred = new cv.Mat();
  let edges = new cv.Mat();
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();

  // Преобразуем в серый, размываем, находим границы
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  cv.Canny(blurred, edges, 75, 200);

  // Ищем контуры
  cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  // Ищем самый большой четырёхугольник (документ)
  let maxArea = 0;
  let docContour = null;
  for (let i = 0; i < contours.size(); i++) {
    let cnt = contours.get(i);
    let peri = cv.arcLength(cnt, true);
    let approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * peri, true); // упрощаем

    if (approx.rows === 4) { // четырёхугольник
      let area = cv.contourArea(approx);
      if (area > maxArea && area > 1000) {
        maxArea = area;
        docContour = approx.clone();
      }
    }
    approx.delete();
  }

  if (!docContour) {
    // Если не нашли – возвращаем исходное изображение без коррекции
    statusDiv.textContent = 'Документ не найден, используем всё изображение.';
    let dataUrl = imageElement.src;
    // Освобождаем ресурсы
    src.delete(); gray.delete(); blurred.delete(); edges.delete();
    contours.delete(); hierarchy.delete();
    return dataUrl;
  }

  // Упорядочиваем углы: верхний-левый, верхний-правый, нижний-правый, нижний-левый
  let corners = [];
  for (let i = 0; i < 4; i++) {
    corners.push({ x: docContour.data32S[i * 2], y: docContour.data32S[i * 2 + 1] });
  }
  // Сортируем по сумме координат (top-left) и разности (top-right)
  corners.sort((a, b) => (a.x + a.y) - (b.x + b.y));
  let tl = corners[0];
  let br = corners[3];
  let tr = corners[1].x - corners[1].y > corners[2].x - corners[2].y ? corners[1] : corners[2];
  let bl = corners[1] === tr ? corners[2] : corners[1];

  // Вычисляем размеры выходного изображения
  let widthA = Math.sqrt(Math.pow(br.x - bl.x, 2) + Math.pow(br.y - bl.y, 2));
  let widthB = Math.sqrt(Math.pow(tr.x - tl.x, 2) + Math.pow(tr.y - tl.y, 2));
  let maxWidth = Math.round(Math.max(widthA, widthB));

  let heightA = Math.sqrt(Math.pow(tr.x - br.x, 2) + Math.pow(tr.y - br.y, 2));
  let heightB = Math.sqrt(Math.pow(tl.x - bl.x, 2) + Math.pow(tl.y - bl.y, 2));
  let maxHeight = Math.round(Math.max(heightA, heightB));

  // Исходные и целевые точки
  let srcPts = cv.matFromArray(4, 2, cv.CV_32FC1, [
    tl.x, tl.y,
    tr.x, tr.y,
    br.x, br.y,
    bl.x, bl.y
  ]);
  let dstPts = cv.matFromArray(4, 2, cv.CV_32FC1, [
    0, 0,
    maxWidth - 1, 0,
    maxWidth - 1, maxHeight - 1,
    0, maxHeight - 1
  ]);

  // Перспективное преобразование
  let M = cv.getPerspectiveTransform(srcPts, dstPts);
  let warped = new cv.Mat();
  cv.warpPerspective(src, warped, M, new cv.Size(maxWidth, maxHeight));

  // Отображаем результат на canvas
  outputCanvas.width = maxWidth;
  outputCanvas.height = maxHeight;
  cv.imshow(outputCanvas, warped);

  // Освобождаем память
  src.delete(); gray.delete(); blurred.delete(); edges.delete();
  contours.delete(); hierarchy.delete();
  docContour.delete();
  srcPts.delete(); dstPts.delete(); M.delete(); warped.delete();

  return outputCanvas.toDataURL('image/png');
}

// -------------------- Улучшение как у сканера --------------------
function applyScannerEffect(canvas) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  // Переводим в серый и вычисляем гистограмму
  let grayValues = [];
  for (let i = 0; i < data.length; i += 4) {
    let gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i] = data[i + 1] = data[i + 2] = gray;  // делаем серым
    grayValues.push(gray);
  }

  // Автоуровни: растягиваем гистограмму от 5% до 95%
  grayValues.sort((a,b)=>a-b);
  let low = grayValues[Math.floor(grayValues.length * 0.05)];
  let high = grayValues[Math.floor(grayValues.length * 0.95)];
  if (high - low < 10) { high = 255; low = 0; } // если контраст и так высокий

  // Применяем растяжение и лёгкую резкость
  for (let i = 0; i < data.length; i += 4) {
    let val = data[i]; // уже серый
    val = (val - low) * (255 / (high - low));
    val = Math.min(255, Math.max(0, val));
    data[i] = data[i + 1] = data[i + 2] = val;
  }
  ctx.putImageData(imageData, 0, 0);
}

// -------------------- Основной процесс сканирования --------------------
async function scanDocument(sourceImage) {
  statusDiv.textContent = 'Обработка...';
  try {
    let processedDataUrl = detectAndCropDocument(sourceImage);

    // Рисуем результат на временный canvas для цветокоррекции
    let img = new Image();
    img.src = processedDataUrl;
    await new Promise((resolve) => { img.onload = resolve; });

    let tempCanvas = document.createElement('canvas');
    tempCanvas.width = img.width;
    tempCanvas.height = img.height;
    tempCanvas.getContext('2d').drawImage(img, 0, 0);

    applyScannerEffect(tempCanvas);
    scannedImageDataUrl = tempCanvas.toDataURL('image/png');

    // Показываем результат
    outputCanvas.width = tempCanvas.width;
    outputCanvas.height = tempCanvas.height;
    outputCanvas.getContext('2d').drawImage(tempCanvas, 0, 0);
    outputCanvas.style.display = 'block';
    video.style.display = 'none';
    overlay.style.display = 'none';
    downloadPdfBtn.disabled = false;
    statusDiv.textContent = 'Готово!';
  } catch (err) {
    statusDiv.textContent = 'Ошибка: ' + err.message;
  }
}

// -------------------- Генерация PDF --------------------
function generatePdf() {
  if (!scannedImageDataUrl) return;
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({
    orientation: outputCanvas.width > outputCanvas.height ? 'landscape' : 'portrait',
    unit: 'px',
    format: [outputCanvas.width, outputCanvas.height]
  });
  pdf.addImage(scannedImageDataUrl, 'PNG', 0, 0, outputCanvas.width, outputCanvas.height);
  pdf.save('scan.pdf');
}

// -------------------- Обработчики событий --------------------
captureBtn.addEventListener('click', async () => {
  if (!opencvReady) {
    statusDiv.textContent = 'OpenCV ещё загружается, подождите...';
    return;
  }
  // Берём кадр с видео
  let tempCanvas = document.createElement('canvas');
  tempCanvas.width = video.videoWidth;
  tempCanvas.height = video.videoHeight;
  tempCanvas.getContext('2d').drawImage(video, 0, 0);
  let dataUrl = tempCanvas.toDataURL('image/png');
  await scanDocument(tempCanvas); // передаём canvas
});

fileInput.addEventListener('change', async (e) => {
  if (!e.target.files.length) return;
  let file = e.target.files[0];
  let img = new Image();
  img.src = URL.createObjectURL(file);
  await new Promise((resolve) => { img.onload = resolve; });
  let tempCanvas = document.createElement('canvas');
  tempCanvas.width = img.width;
  tempCanvas.height = img.height;
  tempCanvas.getContext('2d').drawImage(img, 0, 0);
  await scanDocument(tempCanvas);
});

downloadPdfBtn.addEventListener('click', generatePdf);

// Запускаем камеру при загрузке
startCamera();