// ============================================================
// ZipLLM Interactive Website
// ============================================================

(function () {
  "use strict";

  // ── BF16 Utilities ──────────────────────────────────────
  function floatToBF16(value) {
    const buf = new ArrayBuffer(4);
    new Float32Array(buf)[0] = value;
    return (new Uint32Array(buf)[0] >>> 16) & 0xffff;
  }

  function bf16ToFloat(bf16) {
    const buf = new ArrayBuffer(4);
    new Uint32Array(buf)[0] = bf16 << 16;
    return new Float32Array(buf)[0];
  }

  function bf16ToBits(val) {
    const bits = [];
    for (let i = 15; i >= 0; i--) bits.push((val >> i) & 1);
    return bits;
  }

  function hammingDistance(a, b) {
    let xor = a ^ b;
    let count = 0;
    while (xor) { count += xor & 1; xor >>= 1; }
    return count;
  }

  function countBitsInRange(xor, hi, lo) {
    let count = 0;
    for (let i = hi; i >= lo; i--) count += (xor >> i) & 1;
    return count;
  }

  // ── DOM Helpers ─────────────────────────────────────────
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  function createBitCells(container, bits, regions) {
    container.innerHTML = "";
    let idx = 0;
    regions.forEach(function (r, ri) {
      if (ri > 0) {
        const sep = document.createElement("span");
        sep.className = "bit-sep";
        container.appendChild(sep);
      }
      for (let i = 0; i < r.count; i++) {
        const cell = document.createElement("span");
        cell.className = "bit-cell " + r.cls;
        cell.textContent = bits[idx];
        container.appendChild(cell);
        idx++;
      }
    });
  }

  function createXorCells(container, bits) {
    container.innerHTML = "";
    const regions = [
      { count: 1, label: "sign" },
      { count: 8, label: "exp" },
      { count: 7, label: "mant" },
    ];
    let idx = 0;
    regions.forEach(function (r, ri) {
      if (ri > 0) {
        const sep = document.createElement("span");
        sep.className = "bit-sep";
        container.appendChild(sep);
      }
      for (let i = 0; i < r.count; i++) {
        const cell = document.createElement("span");
        const bit = bits[idx];
        cell.className = "bit-cell " + (bit === 1 ? "changed" : "zero");
        cell.textContent = bit;
        container.appendChild(cell);
        idx++;
      }
    });
  }

  function create8BitCells(container, bits, isAllZero) {
    container.innerHTML = "";
    bits.forEach(function (b) {
      const cell = document.createElement("span");
      cell.className = "bit-cell " + (b === 1 ? "one" : "zero");
      cell.textContent = b;
      container.appendChild(cell);
    });
  }

  var BF16_REGIONS = [
    { count: 1, cls: "sign" },
    { count: 8, cls: "exp" },
    { count: 7, cls: "mant" },
  ];

  // ── Module 1: Pipeline Accordion ────────────────────────
  var pipelineState = 0;
  var pipelineTimeouts = [];

  var ACC_FILLS = [100, 96.8, 91.7, 45.9];
  var ACC_PANELS = ["acc-p0", "acc-p1", "acc-p2", "acc-p3"];
  var ACC_BADGES = [null, "acc-b1", "acc-b2", "acc-b3"];
  var ACC_FILL_IDS = ["acc-f0", "acc-f1", "acc-f2", "acc-f3"];

  function runPipelineAccordion() {
    resetPipelineAccordion();
    ACC_PANELS.forEach(function(pid, i) {
      pipelineTimeouts.push(setTimeout(function() {
        // Remove active from all
        ACC_PANELS.forEach(function(p) { $("#" + p).classList.remove("active"); });
        // Activate current
        $("#" + pid).classList.add("active");
        // Fill bar
        $("#" + ACC_FILL_IDS[i]).style.width = ACC_FILLS[i] + "%";
        // Show badge
        if (ACC_BADGES[i]) $("#" + ACC_BADGES[i]).classList.add("show");
      }, i * 900));
    });
  }

  function resetPipelineAccordion() {
    pipelineTimeouts.forEach(function(t) { clearTimeout(t); });
    pipelineTimeouts = [];
    ACC_PANELS.forEach(function(p) { $("#" + p).classList.remove("active"); });
    ACC_PANELS.forEach(function(p, i) {
      if (i === 0) {
        $("#" + p).classList.add("active");
        $("#" + ACC_FILL_IDS[i]).style.width = "100%";
      } else {
        $("#" + ACC_FILL_IDS[i]).style.width = "0%";
        if (ACC_BADGES[i]) $("#" + ACC_BADGES[i]).classList.remove("show");
      }
    });
  }

  // ── Module 2: BitX Binary Rain ─────────────────────────
  var BITX_PAIRS = [
    [1.0,      1.0078125],
    [0.5,      0.515625],
    [-0.25,    -0.2578125],
    [2.0,      2.0625],
    [0.75,     0.8125],
    [1.5,      1.5625],
    [0.9375,   1.0625],
    [3.0,      3.25]
  ];

  var BW = BITX_PAIRS.map(function(p) {
    var bb = floatToBF16(p[0]), ff = floatToBF16(p[1]), x = bb ^ ff;
    var eb = (x >> 7) & 0xFF, sb = ((x >> 15) & 1) << 7 | (x & 0x7F);
    var eBits = [], sBits = [];
    for (var i = 7; i >= 0; i--) eBits.push((eb >> i) & 1);
    for (var i = 7; i >= 0; i--) sBits.push((sb >> i) & 1);
    return {
      bb: bb, ff: ff, x: x,
      bB: bf16ToBits(bb), fB: bf16ToBits(ff), xB: bf16ToBits(x),
      eb: eb, sb: sb, eBits: eBits, sBits: sBits,
      h: hammingDistance(bb, ff),
      bF: bf16ToFloat(bb), fF: bf16ToFloat(ff)
    };
  });

  var rainRunning = false;
  var rainTimeouts = [];

  function rainBitRow(container, bits, color) {
    var d = document.createElement("div");
    d.className = "rain-row";
    var h = "";
    bits.forEach(function(b) {
      h += '<span class="rain-bit" style="color:' + (b === 1 ? color : "#555") + '">' + b + '</span>';
    });
    d.innerHTML = h;
    container.appendChild(d);
  }

  function runBitxRain() {
    if (rainRunning) return;
    rainRunning = true;
    var T = 250;

    var baseEl = $("#rain-base");
    var fineEl = $("#rain-fine");

    // Phase 1: rain base and fine
    BW.forEach(function(w, i) {
      rainTimeouts.push(setTimeout(function() {
        rainBitRow(baseEl, w.bB, "var(--cyan)");
        rainBitRow(fineEl, w.fB, "var(--orange)");
      }, i * T));
    });

    var t1 = BW.length * T + 400;

    // Phase 2: XOR
    rainTimeouts.push(setTimeout(function() {
      $("#rain-p2").classList.remove("hidden");
      var xorEl = $("#rain-xor");
      BW.forEach(function(w, i) {
        rainTimeouts.push(setTimeout(function() {
          var d = document.createElement("div");
          d.className = "rain-row";
          var h = "";
          w.xB.forEach(function(b, j) {
            if (j === 1 || j === 9) h += '<span style="color:#1c1c1c"> </span>';
            h += '<span class="rain-bit" style="color:' + (b === 1 ? "var(--yellow)" : "#444") + '">' + b + '</span>';
          });
          h += ' <span style="font-family:var(--font-mono);font-size:.78rem;color:var(--text-3)">' + w.h + ' bits</span>';
          d.innerHTML = h;
          xorEl.appendChild(d);
        }, i * T));
      });
    }, t1));

    var t2 = t1 + BW.length * T + 500;

    // Phase 3: split into dashed boxes
    rainTimeouts.push(setTimeout(function() {
      $("#rain-p3").classList.remove("hidden");
      var expEl = $("#rain-exp");
      var smEl = $("#rain-sm");
      BW.forEach(function(w, i) {
        rainTimeouts.push(setTimeout(function() {
          // EXP byte
          var ed = document.createElement("div");
          ed.className = "rain-row";
          var eh = "";
          w.eBits.forEach(function(b) {
            eh += '<span class="rain-bit" style="color:' + (b === 1 ? "var(--cyan)" : "#555") + '">' + b + '</span>';
          });
          if (w.eb === 0) eh += ' <span style="color:var(--accent);font-size:.78rem">\u2713</span>';
          else eh += ' <span style="color:var(--yellow);font-size:.78rem">\u26a0</span>';
          ed.innerHTML = eh;
          expEl.appendChild(ed);

          // S+M byte
          var sd = document.createElement("div");
          sd.className = "rain-row";
          var sh = "";
          w.sBits.forEach(function(b) {
            sh += '<span class="rain-bit" style="color:' + (b === 1 ? "var(--orange)" : "#555") + '">' + b + '</span>';
          });
          sd.innerHTML = sh;
          smEl.appendChild(sd);
        }, i * T));
      });
    }, t2));

    var t3 = t2 + BW.length * T + 500;

    // Phase 4: compression bars
    rainTimeouts.push(setTimeout(function() {
      $("#rain-p4").classList.remove("hidden");
      setTimeout(function() {
        $("#rain-exp-comp").style.width = "5%";
        $("#rain-sm-comp").style.width = "25%";
      }, 200);
    }, t3));
  }

  function resetBitxRain() {
    // Clear all timeouts
    rainTimeouts.forEach(function(t) { clearTimeout(t); });
    rainTimeouts = [];
    rainRunning = false;

    // Clear rain rows
    ["rain-base", "rain-fine", "rain-xor", "rain-exp", "rain-sm"].forEach(function(id) {
      var el = $("#" + id);
      if (el) el.innerHTML = "";
    });

    // Hide phases 2-4
    ["rain-p2", "rain-p3", "rain-p4"].forEach(function(id) {
      var el = $("#" + id);
      if (el) el.classList.add("hidden");
    });

    // Reset compression bars
    var ec = $("#rain-exp-comp");
    var sc = $("#rain-sm-comp");
    if (ec) ec.style.width = "0%";
    if (sc) sc.style.width = "0%";
  }

  // ── Module 3: BF16 Explorer ────────────────────────────
  function updateExplorer() {
    var baseVal = parseFloat($("#base-value").value) || 0;
    var sliderVal = parseInt($("#delta-slider").value);
    // Nonlinear mapping: slider -100..100 maps to delta via cubic for finer control near 0
    var t = sliderVal / 100;
    var delta = t * t * t; // cubic for fine control near zero
    if (sliderVal < 0) delta = -(Math.abs(t) * Math.abs(t) * Math.abs(t));

    var sign = delta >= 0 ? "+" : "";
    $("#delta-display").textContent = sign + delta.toFixed(6);

    var origBF16 = floatToBF16(baseVal);
    var modBF16 = floatToBF16(baseVal + delta);
    var xor = origBF16 ^ modBF16;

    var origBits = bf16ToBits(origBF16);
    var modBits = bf16ToBits(modBF16);
    var xorBits = bf16ToBits(xor);

    createBitCells($("#exp-original-bits"), origBits, BF16_REGIONS);
    createBitCells($("#exp-modified-bits"), modBits, BF16_REGIONS);
    createXorCells($("#exp-xor-bits"), xorBits);

    $("#exp-original-val").textContent = "(" + bf16ToFloat(origBF16).toFixed(6) + ")";
    $("#exp-modified-val").textContent = "(" + bf16ToFloat(modBF16).toFixed(6) + ")";

    var hd = hammingDistance(origBF16, modBF16);
    var xorHex = "0x" + xor.toString(16).padStart(4, "0").toUpperCase();
    $("#exp-xor-val").textContent = xorHex;

    $("#hamming-distance").textContent = hd;
    $("#exp-bits-changed").textContent = countBitsInRange(xor, 14, 7);
    $("#mant-bits-changed").textContent = countBitsInRange(xor, 6, 0);
    $("#sign-changed").textContent = (xor >> 15) & 1;
  }

  // ── Module 4: Pseudocode ───────────────────────────────
  function renderPseudocode() {
    var pipelineCode =
      '<span class="kw">fn</span> <span class="fn">zipllm_pipeline</span>(models: <span class="ty">Vec&lt;Model&gt;</span>) {\n' +
      '    <span class="kw">let mut</span> file_index  = <span class="ty">HashMap</span>::new();\n' +
      '    <span class="kw">let mut</span> tensor_index = <span class="ty">HashMap</span>::new();\n' +
      "\n" +
      '    <span class="kw">for</span> model <span class="kw">in</span> models {\n' +
      '        <span class="kw">let</span> base = find_base_model(&amp;model);\n' +
      "\n" +
      '        <span class="cm">// Stage 1: File-level deduplication</span>\n' +
      '        <span class="kw">for</span> file <span class="kw">in</span> model.safetensor_files {\n' +
      '            <span class="kw">let</span> hash = xxhash(file.bytes);\n' +
      '            <span class="kw">if</span> file_index.contains(&amp;hash) {\n' +
      '                <span class="kw">continue</span>;  <span class="cm">// identical file, skip</span>\n' +
      "            }\n" +
      "            file_index.insert(hash, file);\n" +
      "        }\n" +
      "\n" +
      '        <span class="cm">// Stage 2: Tensor-level deduplication</span>\n' +
      '        <span class="kw">for</span> tensor <span class="kw">in</span> model.tensors() {\n' +
      '            <span class="kw">let</span> hash = xxhash(tensor.data);\n' +
      '            <span class="kw">if</span> tensor_index.contains(&amp;hash) {\n' +
      "                record_ref(tensor, hash);\n" +
      '                <span class="kw">continue</span>;  <span class="cm">// duplicate tensor</span>\n' +
      "            }\n" +
      "            tensor_index.insert(hash, tensor);\n" +
      "            store_unique(tensor);\n" +
      "        }\n" +
      "\n" +
      '        <span class="cm">// Stage 3: Compression</span>\n' +
      '        <span class="kw">if let</span> <span class="ty">Some</span>(base) = base {\n' +
      '            <span class="cm">// Finetune: BitX with base</span>\n' +
      '            <span class="kw">for</span> (b, f) <span class="kw">in</span> pair_tensors(base, model) {\n' +
      '                <span class="kw">let</span> c = <span class="fn">bitx_compress</span>(b, f);\n' +
      "                store_compressed(f, c);\n" +
      "            }\n" +
      '        } <span class="kw">else</span> {\n' +
      '            <span class="cm">// Base model: Zstd</span>\n' +
      '            <span class="kw">for</span> t <span class="kw">in</span> unique_tensors(model) {\n' +
      "                store_compressed(t, zstd(t.data));\n" +
      "            }\n" +
      "        }\n" +
      "    }\n" +
      "}";

    var bitxCode =
      '<span class="cm">// BitX: XOR + stream split + Zstd</span>\n' +
      '<span class="kw">fn</span> <span class="fn">bitx_compress</span>(\n' +
      '    base: &amp;[<span class="ty">u8</span>], fine: &amp;[<span class="ty">u8</span>]\n' +
      ') -&gt; (<span class="ty">Vec&lt;u8&gt;</span>, <span class="ty">Vec&lt;u8&gt;</span>) {\n' +
      '    <span class="kw">let</span> n = base.len() / <span class="nu">2</span>;\n' +
      '    <span class="kw">let mut</span> exp_s = <span class="kw">vec!</span>[<span class="nu">0u8</span>; n];\n' +
      '    <span class="kw">let mut</span> sm_s  = <span class="kw">vec!</span>[<span class="nu">0u8</span>; n];\n' +
      "\n" +
      '    <span class="kw">for</span> i <span class="kw">in</span> <span class="nu">0</span>..n {\n' +
      '        <span class="kw">let</span> b = read_u16(base, i*<span class="nu">2</span>);\n' +
      '        <span class="kw">let</span> f = read_u16(fine, i*<span class="nu">2</span>);\n' +
      '        <span class="kw">let</span> xor = b ^ f;\n' +
      "\n" +
      '        <span class="cm">// Split 16-bit XOR into 2 bytes</span>\n' +
      '        <span class="kw">let</span> sign = (xor &gt;&gt; <span class="nu">15</span>) &amp; <span class="nu">0x1</span>;\n' +
      '        <span class="kw">let</span> exp  = (xor &gt;&gt; <span class="nu">7</span>)  &amp; <span class="nu">0xFF</span>;\n' +
      '        <span class="kw">let</span> mant = xor &amp; <span class="nu">0x7F</span>;\n' +
      "\n" +
      '        exp_s[i] = exp <span class="kw">as</span> <span class="ty">u8</span>;\n' +
      '        sm_s[i]  = ((sign&lt;&lt;<span class="nu">7</span>)|mant) <span class="kw">as</span> <span class="ty">u8</span>;\n' +
      "    }\n" +
      "\n" +
      '    <span class="cm">// Compress independently</span>\n' +
      '    (zstd(&amp;exp_s), zstd(&amp;sm_s))\n' +
      "}\n" +
      "\n" +
      '<span class="cm">// BitX Decompression</span>\n' +
      '<span class="kw">fn</span> <span class="fn">bitx_decompress</span>(\n' +
      '    base: &amp;[<span class="ty">u8</span>], c_exp: &amp;[<span class="ty">u8</span>], c_sm: &amp;[<span class="ty">u8</span>]\n' +
      ') -&gt; <span class="ty">Vec&lt;u8&gt;</span> {\n' +
      '    <span class="kw">let</span> exp = zstd_d(c_exp);\n' +
      '    <span class="kw">let</span> sm  = zstd_d(c_sm);\n' +
      '    <span class="kw">let mut</span> out = <span class="kw">vec!</span>[<span class="nu">0u8</span>; exp.len()*<span class="nu">2</span>];\n' +
      "\n" +
      '    <span class="kw">for</span> i <span class="kw">in</span> <span class="nu">0</span>..exp.len() {\n' +
      '        <span class="kw">let</span> sign = (sm[i]&gt;&gt;<span class="nu">7</span>) &amp; <span class="nu">1</span>;\n' +
      '        <span class="kw">let</span> mant = sm[i] &amp; <span class="nu">0x7F</span>;\n' +
      '        <span class="kw">let</span> xor = (sign <span class="kw">as</span> <span class="ty">u16</span>&lt;&lt;<span class="nu">15</span>)\n' +
      '                | (exp[i] <span class="kw">as</span> <span class="ty">u16</span>&lt;&lt;<span class="nu">7</span>)\n' +
      '                | mant <span class="kw">as</span> <span class="ty">u16</span>;\n' +
      '        <span class="kw">let</span> orig = read_u16(base, i*<span class="nu">2</span>);\n' +
      '        write_u16(&amp;<span class="kw">mut</span> out, i*<span class="nu">2</span>, orig^xor);\n' +
      "    }\n" +
      "    out\n" +
      "}";

    var el1 = document.getElementById("code-pipeline");
    var el2 = document.getElementById("code-bitx");
    if (el1) el1.innerHTML = pipelineCode;
    if (el2) el2.innerHTML = bitxCode;
  }

  // ── Module 5: Demo Video Comparison ────────────────────
  var demoRafId = null;

  function fmtTime(s) {
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  function demoTick() {
    var va = $("#demo-zipnn"), vb = $("#demo-bitx");
    if (!va || !vb) return;
    var dur = va.duration || 0;
    var cur = va.currentTime || 0;
    if (dur > 0) {
      $("#demo-progress-fill").style.width = (cur / dur * 100) + "%";
      $("#demo-time-current").textContent = fmtTime(cur);
      $("#demo-time-total").textContent = fmtTime(dur);
    }
    if (!va.paused) demoRafId = requestAnimationFrame(demoTick);
  }

  function demoPlay() {
    var va = $("#demo-zipnn"), vb = $("#demo-bitx");
    va.play(); vb.play();
    demoRafId = requestAnimationFrame(demoTick);
  }

  function demoPause() {
    var va = $("#demo-zipnn"), vb = $("#demo-bitx");
    va.pause(); vb.pause();
    if (demoRafId) { cancelAnimationFrame(demoRafId); demoRafId = null; }
  }

  function demoRestart() {
    var va = $("#demo-zipnn"), vb = $("#demo-bitx");
    va.currentTime = 0; vb.currentTime = 0;
    va.play(); vb.play();
    demoRafId = requestAnimationFrame(demoTick);
  }

  // ── Init ───────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", function () {
    // Pipeline Accordion
    $("#btn-pipeline-run").addEventListener("click", function () {
      runPipelineAccordion();
    });
    $("#btn-pipeline-reset").addEventListener("click", resetPipelineAccordion);

    // BitX Rain
    $("#btn-bitx-run").addEventListener("click", function () {
      resetBitxRain();
      runBitxRain();
    });
    $("#btn-bitx-reset").addEventListener("click", resetBitxRain);

    // BF16 Explorer
    updateExplorer();
    $("#delta-slider").addEventListener("input", updateExplorer);
    $("#base-value").addEventListener("input", updateExplorer);

    // Pseudocode
    renderPseudocode();

    // Demo Video Comparison
    if ($("#btn-demo-play")) {
      $("#btn-demo-play").addEventListener("click", demoPlay);
      $("#btn-demo-pause").addEventListener("click", demoPause);
      $("#btn-demo-restart").addEventListener("click", demoRestart);

      // Click on progress bar to seek
      $("#demo-progress").addEventListener("click", function (e) {
        var rect = this.getBoundingClientRect();
        var pct = (e.clientX - rect.left) / rect.width;
        var va = $("#demo-zipnn"), vb = $("#demo-bitx");
        if (va.duration) { va.currentTime = pct * va.duration; }
        if (vb.duration) { vb.currentTime = pct * vb.duration; }
        demoTick();
      });
    }
  });
})();
