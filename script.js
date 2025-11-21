
const $ = id => document.getElementById(id);
function setStatus(t){ const s=$('status'); if(s) s.innerText = t; }
function setProgress(v){ const p=$('progress'); if(p) p.value = v; }
function setHTML(id, html){ const el=$(id); if(el) el.innerHTML = html; }
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function fileToArrayBuffer(file){
  return await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsArrayBuffer(file);
  });
}
async function sha256HexFromArrayBuffer(buffer){
  const hb = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hb)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ---- Rendering (PDF first page or image) ----
async function fileToImageBitmap(file){
  const name = (file.name||'').toLowerCase();
  if(name.endsWith('.pdf') && window.pdfjsLib){
    const ab = await fileToArrayBuffer(file);
    const loading = pdfjsLib.getDocument({ data: new Uint8Array(ab) });
    const pdf = await loading.promise;
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return await createImageBitmap(canvas);
  } else {
    if (window.createImageBitmap) return await createImageBitmap(file);
    return await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img,0,0);
        createImageBitmap(c).then(res).catch(rej);
      };
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
  }
}
async function imageBitmapToPNGArrayBuffer(bitmap){
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  return await fileToArrayBuffer(blob);
}

// ---- aHash ----
async function averageHashFromImageBitmap(bitmap){
  const canvas = document.createElement('canvas');
  canvas.width = 8; canvas.height = 8;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, 8, 8);
  const d = ctx.getImageData(0,0,8,8).data;
  const vals = [];
  for(let i=0;i<d.length;i+=4){
    const r=d[i], g=d[i+1], b=d[i+2];
    const gray = Math.round(0.299*r + 0.587*g + 0.114*b);
    vals.push(gray);
  }
  const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
  let bits='';
  for(const v of vals) bits += (v>=mean ? '1':'0');
  return parseInt(bits,2).toString(16).padStart(16,'0');
}
function hammingHex(aHex, bHex){
  try{
    const a = BigInt('0x'+aHex), b = BigInt('0x'+bHex);
    let x = a ^ b, dist = 0;
    while(x){ dist += Number(x & 1n); x >>= 1n; }
    return dist;
  }catch(e){
    if(!aHex || !bHex) return 64;
    const L = Math.max(aHex.length, bHex.length);
    const A = aHex.padStart(L,'0'), B = bHex.padStart(L,'0');
    let d=0; for(let i=0;i<L;i++) if(A[i]!==B[i]) d++;
    return d;
  }
}

// ---- ELA ----
async function computeELA(bitmap, quality=90){
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const original = ctx.getImageData(0,0,canvas.width, canvas.height);

  const jpegBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality/100));
  const jpegArrBuf = await new Promise(res => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsArrayBuffer(jpegBlob);
  });

  const img = await new Promise((res,rej)=>{
    const temp = new Image();
    temp.onload = ()=>res(temp);
    temp.onerror = rej;
    temp.src = URL.createObjectURL(new Blob([jpegArrBuf]));
  });
  const c2 = document.createElement('canvas');
  c2.width = canvas.width; c2.height = canvas.height;
  c2.getContext('2d').drawImage(img,0,0);
  const compressed = c2.getContext('2d').getImageData(0,0,c2.width,c2.height);

  const diff = new Uint8ClampedArray(original.data.length);
  for(let i=0;i<original.data.length;i+=4){
    const r0 = original.data[i], g0 = original.data[i+1], b0 = original.data[i+2];
    const r1 = compressed.data[i], g1 = compressed.data[i+1], b1 = compressed.data[i+2];
    const lum0 = 0.299*r0 + 0.587*g0 + 0.114*b0;
    const lum1 = 0.299*r1 + 0.587*g1 + 0.114*b1;
    const dval = Math.abs(lum0 - lum1);
    const v = Math.min(255, Math.round(dval * 4));
    diff[i] = diff[i+1] = diff[i+2] = v;
    diff[i+3] = 255;
  }
  return new ImageData(diff, canvas.width, canvas.height);
}

// ---- Edge map (Sobel) ----
function computeEdgeMap(bitmap){
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0,0,canvas.width,canvas.height);
  const w = canvas.width, h = canvas.height;
  const out = new Uint8ClampedArray(img.data.length);
  const gray = new Float32Array(w*h);
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const i = (y*w + x)*4;
      gray[y*w + x] = 0.299*img.data[i] + 0.587*img.data[i+1] + 0.114*img.data[i+2];
    }
  }
  const gx = [-1,0,1,-2,0,2,-1,0,1];
  const gy = [-1,-2,-1,0,0,0,1,2,1];
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      let sx=0, sy=0, k=0;
      for(let j=-1;j<=1;j++){
        for(let i=-1;i<=1;i++){
          const val = gray[(y+j)*w + (x+i)];
          sx += gx[k]*val; sy += gy[k]*val; k++;
        }
      }
      const mag = Math.min(255, Math.sqrt(sx*sx + sy*sy));
      const idx = (y*w + x)*4;
      out[idx] = out[idx+1] = out[idx+2] = mag;
      out[idx+3] = 255;
    }
  }
  return new ImageData(out, w, h);
}

// ---- Color stats ----
function colorStatsFromImageBitmap(bitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap,0,0);
  const data = ctx.getImageData(0,0,canvas.width,canvas.height).data;
  let rsum=0, gsum=0, bsum=0, n=0;
  for(let i=0;i<data.length;i+=4){ rsum+=data[i]; gsum+=data[i+1]; bsum+=data[i+2]; n++; }
  return { meanRGB: [Math.round(rsum/n), Math.round(gsum/n), Math.round(bsum/n)] };
}

// ---- OCR wrapper ----
async function runOCRFromBitmap(bitmap, onProgress){
  if(!window.Tesseract) return "";
  const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap,0,0);
  const blob = await new Promise(r=>canvas.toBlob(r,'image/png'));
  return new Promise((res, rej) => {
    Tesseract.recognize(blob, 'eng', {
      logger: m => { if(m.status === "recognizing text" && onProgress) onProgress(m.progress); }
    }).then(r => res(r.data.text)).catch(e => { console.warn("Tesseract error", e); res(''); });
  });
}

// ---- Drawing helpers ----
function drawToCanvas(id, bitmap){
  const c = $(id);
  if(!c) return;
  c.width = bitmap.width; c.height = bitmap.height;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,c.width,c.height);
  ctx.drawImage(bitmap, 0, 0);
}
function putImageDataToCanvas(id, imageData){
  const c = $(id);
  if(!c) return;
  c.width = imageData.width; c.height = imageData.height;
  c.getContext('2d').putImageData(imageData, 0, 0);
}

// ---- Text similarity (levenshtein) ----
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b ? b.length : 0;
  if (!b) return a.length;
  a = a.toLowerCase(); b = b.toLowerCase();
  const dp = Array.from({length: a.length + 1}, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}
function textSimilarity(a, b) {
  a = (a || "").replace(/\s+/g, " ").trim();
  b = (b || "").replace(/\s+/g, " ").trim();
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const d = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return Math.max(0, 1 - d / maxLen);
}

// ---- Analyzer orchestration ----
async function analyzeFile(file){
  try{
    setStatus("Preparing...");
    setProgress(5);

    const bitmap = await fileToImageBitmap(file);
    drawToCanvas('renderCanvas', bitmap);
    setProgress(15);

    const pngArr = await imageBitmapToPNGArrayBuffer(bitmap);
    const fileHash = await sha256HexFromArrayBuffer(pngArr);
    setProgress(25);

    const aHash = await averageHashFromImageBitmap(bitmap);
    setProgress(35);

    const colorStats = colorStatsFromImageBitmap(bitmap);
    setProgress(45);

    setStatus("Computing ELA...");
    const elaData = await computeELA(bitmap, 90);
    putImageDataToCanvas('elaCanvas', elaData);
    setProgress(60);

    setStatus("Computing edge map...");
    const edgeData = computeEdgeMap(bitmap);
    putImageDataToCanvas('edgeCanvas', edgeData);
    setProgress(70);

    setStatus("Running OCR (if available)...");
    const ocrText = await runOCRFromBitmap(bitmap, p => setProgress(70 + Math.round(p*20)));
    setProgress(92);

    const tokens = ["name","certificate","degree","institution","university","date","roll","reg","id"];
    const ocrLower = (ocrText || "").toLowerCase();
    const tokenHits = tokens.map(t => ({ token: t, found: ocrLower.includes(t) }));

    const elaCtx = $('elaCanvas').getContext('2d');
    const elaImg = elaCtx.getImageData(0,0,$('elaCanvas').width,$('elaCanvas').height).data;
    let bright=0, total=elaImg.length/4;
    for(let i=0;i<elaImg.length;i+=4){
      if(elaImg[i] > 50 || elaImg[i+1] > 50 || elaImg[i+2] > 50) bright++;
    }
    const elaPercent = Math.round((bright/total)*100);

    const signals = {
      fileName: file.name,
      sha256: fileHash,
      aHash,
      meanRGB: colorStats.meanRGB,
      elaPercent,
      ocrSnippet: ocrText.trim().slice(0,500)
    };

    const reasons = [];
    if(elaPercent > 3) reasons.push({ title: "ELA hotspots", detail: `ELA shows ${elaPercent}% bright pixels — signs of recompression/editing in localized regions.` });
    if(signals.meanRGB.every(v=>v < 40)) reasons.push({ title: "Low contrast", detail: "Image is generally dark/low-contrast — OCR and some visual checks may be unreliable." });
    if(!tokenHits.some(t=>t.found)) reasons.push({ title: "Missing expected text tokens", detail: "Common words like 'Name', 'Certificate', or 'Institution' weren't found — OCR may have failed or text was altered." });
    if(/^0+$/.test(aHash)) reasons.push({ title: "Weak visual fingerprint", detail: "Image has low variance after downsampling — logo detection via aHash is not very informative." });

    let verdict = { label: "Unknown", color: "#ffb300", explanation: "Insufficient signals" };
    if(elaPercent >= 10) { verdict = { label: "Likely Tampered", color: "#ff5252", explanation: "ELA detected widespread recompression/artifacts suggesting edits or pasted regions." }; }
    else if(reasons.length > 0) { verdict = { label: "Suspicious", color: "#ff8a00", explanation: "One or more signals indicate potential issues; manual review recommended." }; }
    else { verdict = { label: "No obvious tampering detected", color: "#4caf50", explanation: "Basic checks did not find strong signs of tampering." }; }

    setProgress(98);
    setStatus("Analysis complete");

    renderSummary(verdict, signals);
    renderSignals(signals, tokenHits, reasons);
    setProgress(100);
    setTimeout(()=> setProgress(0), 400);
  }catch(err){
    console.error("analyzeFile error", err);
    setStatus("Error: " + (err.message || err));
    setProgress(0);
  }
}

function renderSummary(verdict, signals){
  const html = `
    <h3 style="color:${verdict.color}; margin:6px 0">${verdict.label}</h3>
    <p><strong>Why:</strong> ${verdict.explanation}</p>
    <p><strong>File:</strong> ${escapeHtml(signals.fileName)}</p>
    <p><strong>SHA-256:</strong> <code style="color:#ddd">${signals.sha256}</code></p>
    <p><strong>aHash:</strong> ${signals.aHash}</p>
    <p><strong>Mean RGB:</strong> ${signals.meanRGB.join(', ')}</p>
    <p><strong>ELA bright %:</strong> ${signals.elaPercent}%</p>
  `;
  setHTML('summary', html);
}

function renderSignals(signals, tokenHits, reasons){
  let html = `<h4>Detailed Signals</h4>`;
  html += `<ul>`;
  for(const t of tokenHits) html += `<li>${t.found ? "✔" : "✖"} Token "${t.token}"</li>`;
  html += `</ul>`;
  html += `<h4>OCR (snippet)</h4><div style="background:#0b0b0b;padding:8px;border-radius:6px;white-space:pre-wrap;max-height:140px;overflow:auto;">${escapeHtml(signals.ocrSnippet || "[no text detected]")}</div>`;
  if(reasons && reasons.length){
    html += `<h4>Detected Issues (explainers)</h4><ol>`;
    for(const r of reasons) html += `<li><strong>${escapeHtml(r.title)}:</strong> ${escapeHtml(r.detail)}</li>`;
    html += `</ol>`;
  } else {
    html += `<p style="color:#9f9">No major issues detected by automated checks.</p>`;
  }
  html += `<h4>Suggested next steps</h4><ul>
    <li>Request the original file from issuer and compare the SHA-256.</li>
    <li>If suspicious, ask for authenticated digital copy (signed PDF) or on-chain anchor.</li>
    <li>Provide a higher-quality scan (300 DPI) for better OCR & analysis.</li>
  </ul>`;
  setHTML('signals', html);
}

// ---- Compare Mode implementation ----
let lastCompareReport = null;

async function compareTrustedAndSuspect(trustedFile, suspectFile) {
  const threshold = 30; // used for hotspot detection
  $('compareStatus').innerText = "Rendering trusted file...";
  const tBitmap = await fileToImageBitmap(trustedFile);
  const tPng = await imageBitmapToPNGArrayBuffer(tBitmap);
  const tHash = await sha256HexFromArrayBuffer(tPng);
  const tAhash = await averageHashFromImageBitmap(tBitmap);

  $('compareStatus').innerText = "Rendering suspect file...";
  const sBitmap = await fileToImageBitmap(suspectFile);
  const sPng = await imageBitmapToPNGArrayBuffer(sBitmap);
  const sHash = await sha256HexFromArrayBuffer(sPng);
  const sAhash = await averageHashFromImageBitmap(sBitmap);

  drawToCanvas('renderCanvas', sBitmap);

  const w = Math.min(tBitmap.width, sBitmap.width, 1200);
  function bitmapToImageDataAtWidth(bitmap, width) {
    const scale = width / bitmap.width;
    const ch = Math.round(bitmap.height * scale);
    const c = document.createElement('canvas');
    c.width = width; c.height = ch;
    c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
    return c.getContext('2d').getImageData(0,0,c.width,c.height);
  }
  const tImgData = bitmapToImageDataAtWidth(tBitmap, w);
  const sImgData = bitmapToImageDataAtWidth(sBitmap, w);

  let totalDiff = 0;
  for (let i = 0; i < tImgData.data.length; i += 4) {
    const lumT = 0.299*tImgData.data[i] + 0.587*tImgData.data[i+1] + 0.114*tImgData.data[i+2];
    const lumS = 0.299*sImgData.data[i] + 0.587*sImgData.data[i+1] + 0.114*sImgData.data[i+2];
    totalDiff += Math.abs(lumT - lumS);
  }
  const numPixels = tImgData.data.length/4;
  const pixelDiffPercent = Math.round((totalDiff / (numPixels * 255)) * 100);

  $('compareStatus').innerText = "Computing ELA and hotspots...";
  const tEla = await computeELA(tBitmap, 90);
  const sEla = await computeELA(sBitmap, 90);

  function resizeImageDataTo(imgData, width) {
    const c = document.createElement('canvas');
    c.width = width; c.height = Math.round(imgData.height * width / imgData.width);
    c.getContext('2d').putImageData(imgData,0,0);
    const c2 = document.createElement('canvas');
    c2.width = width; c2.height = Math.round(imgData.height * width / imgData.width);
    const ctx = c2.getContext('2d');
    ctx.drawImage(c,0,0,c2.width,c2.height);
    return ctx.getImageData(0,0,c2.width,c2.height);
  }
  const tElaResized = resizeImageDataTo(tEla, w);
  const sElaResized = resizeImageDataTo(sEla, w);

  const elaDiff = new Uint8ClampedArray(sElaResized.data.length);
  for (let i = 0; i < sElaResized.data.length; i += 4) {
    const valT = tElaResized.data[i];
    const valS = sElaResized.data[i];
    const d = Math.max(0, valS - valT);
    const v = Math.min(255, d * 2);
    elaDiff[i] = elaDiff[i+1] = elaDiff[i+2] = v;
    elaDiff[i+3] = 255;
  }
  const elaImageData = new ImageData(elaDiff, sElaResized.width, sElaResized.height);

  // grid hotspot detection
  const gridSize = 16;
  const gw = Math.ceil(elaImageData.width / gridSize);
  const gh = Math.ceil(elaImageData.height / gridSize);
  const cells = new Array(gw*gh).fill(0);
  for (let gy=0; gy<gh; gy++){
    for (let gx=0; gx<gw; gx++){
      let sum = 0, count = 0;
      for (let y = gy*gridSize; y < Math.min((gy+1)*gridSize, elaImageData.height); y++){
        for (let x = gx*gridSize; x < Math.min((gx+1)*gridSize, elaImageData.width); x++){
          const idx = (y*elaImageData.width + x)*4;
          const v = elaImageData.data[idx];
          sum += v; count++;
        }
      }
      const avg = sum / Math.max(1, count);
      if (avg >= threshold) cells[gy*gw + gx] = 1;
    }
  }
  // merge cells into boxes
  const boxes = [];
  const visited = new Array(cells.length).fill(false);
  function flood(gx, gy) {
    const stack = [[gx,gy]];
    let minx=Infinity, miny=Infinity, maxx=-1, maxy=-1;
    while(stack.length){
      const [cx,cy] = stack.pop();
      if(cx<0||cx>=gw||cy<0||cy>=gh) continue;
      const idx = cy*gw + cx;
      if(visited[idx]||cells[idx]===0) continue;
      visited[idx]=true;
      minx = Math.min(minx, cx); miny = Math.min(miny, cy);
      maxx = Math.max(maxx, cx); maxy = Math.max(maxy, cy);
      for (let ny = cy-1; ny <= cy+1; ny++){
        for (let nx = cx-1; nx <= cx+1; nx++){
          const nidx = ny*gw + nx;
          if(nx>=0&&nx<gw&&ny>=0&&ny<gh && !visited[nidx] && cells[nidx]) stack.push([nx,ny]);
        }
      }
    }
    if(minx<=maxx && miny<=maxy) {
      boxes.push({
        x: minx * gridSize,
        y: miny * gridSize,
        w: (maxx - minx + 1) * gridSize,
        h: (maxy - miny + 1) * gridSize
      });
    }
  }
  for(let gy=0; gy<gh; gy++){
    for(let gx=0; gx<gw; gx++){
      const idx = gy*gw + gx;
      if(cells[idx] && !visited[idx]) flood(gx, gy);
    }
  }

  const ahamming = hammingHex(tAhash, sAhash);
  const asim = Math.round((1 - Math.min(ahamming,64)/64) * 100);

  $('compareStatus').innerText = "Running OCR (optional) ...";
  const tOCR = window.Tesseract ? (await runOCRFromBitmap(tBitmap, p=>{}) ) : "";
  const sOCR = window.Tesseract ? (await runOCRFromBitmap(sBitmap, p=>{}) ) : "";
  const textSim = tOCR && sOCR ? Math.round(textSimilarity(tOCR, sOCR)*100) : null;

  const report = {
    trusted: { fileName: trustedFile.name, sha256: tHash, aHash: tAhash },
    suspect: { fileName: suspectFile.name, sha256: sHash, aHash: sAhash },
    metrics: {
      pixelDiffPercent,
      aHashHamming: ahamming,
      aHashSimilarity: asim,
      ocrSimilarity: textSim,
      hotspotBoxes: boxes,
      thresholdUsed: threshold,
      gridSize
    },
    timestamp: new Date().toISOString()
  };

  putImageDataToCanvas('elaCanvas', elaImageData);

  // Overlay boxes on render canvas
  const renderC = $('renderCanvas');
  if(renderC){
    const ctx = renderC.getContext('2d');
    ctx.strokeStyle = 'rgba(255,0,0,0.9)';
    ctx.lineWidth = Math.max(2, Math.round(renderC.width / 300));
    const scaleX = renderC.width / elaImageData.width;
    const scaleY = renderC.height / elaImageData.height;
    boxes.forEach(b => {
      ctx.strokeRect(Math.round(b.x*scaleX), Math.round(b.y*scaleY), Math.round(b.w*scaleX), Math.round(b.h*scaleY));
    });
  }

  lastCompareReport = report;
  $('compareStatus').innerText = "Comparison done";

  let html = `<h3>Comparison Report</h3>`;
  html += `<p><strong>Trusted:</strong> ${escapeHtml(trustedFile.name)} — SHA256: ${tHash.slice(0,12)}...</p>`;
  html += `<p><strong>Suspect:</strong> ${escapeHtml(suspectFile.name)} — SHA256: ${sHash.slice(0,12)}...</p>`;
  html += `<ul><li>Pixel diff: ${pixelDiffPercent}%</li><li>aHash similarity: ${asim}% (Hamming ${ahamming})</li>`;
  if(textSim !== null) html += `<li>OCR similarity: ${textSim}%</li>`;
  html += `<li>Hotspot boxes detected: ${boxes.length}</li></ul>`;
  setHTML('compareResult', html);

  return report;
}

// ---- Bind UI ----
document.addEventListener('DOMContentLoaded', () => {
  $('analyzeBtn').addEventListener('click', async () => {
    const f = $('inputFile').files && $('inputFile').files[0];
    if(!f) return alert('Choose a file first');
    await analyzeFile(f);
  });

  $('compareBtn').addEventListener('click', async () => {
    const t = $('trustedFile').files[0];
    const s = $('suspectFile').files[0];
    if(!t || !s) return alert('Choose both trusted and suspect files');
    try {
      await compareTrustedAndSuspect(t, s);
    } catch(e){
      console.error('Compare failed', e);
      $('compareStatus').innerText = "Error: " + (e.message||e);
    }
  });

  $('downloadReportBtn').addEventListener('click', ()=>{
    if(!lastCompareReport) return alert('No report available. Run Compare first.');
    const blob = new Blob([JSON.stringify(lastCompareReport, null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'compare_report.json'; a.click();
    URL.revokeObjectURL(a.href);
  });
});
