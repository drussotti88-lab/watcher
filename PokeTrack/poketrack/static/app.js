// Chart hover tooltips and a couple of small conveniences. No dependencies.
(function () {
  var tip = document.createElement("div");
  tip.id = "tip";
  document.body.appendChild(tip);

  function show(e, text) {
    tip.textContent = text;
    tip.classList.add("on");
    move(e);
  }
  function move(e) {
    var pad = 14;
    var x = e.clientX + pad, y = e.clientY + pad;
    var r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }
  function hide() { tip.classList.remove("on"); }

  document.addEventListener("mouseover", function (e) {
    var el = e.target.closest("[data-tip]");
    if (el) show(e, el.getAttribute("data-tip"));
  });
  document.addEventListener("mousemove", function (e) {
    if (tip.classList.contains("on")) move(e);
  });
  document.addEventListener("mouseout", function (e) {
    if (e.target.closest("[data-tip]")) hide();
  });

  // Confirm anything destructive.
  document.addEventListener("submit", function (e) {
    var msg = e.target.getAttribute("data-confirm");
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // Auto-submit filter dropdowns.
  document.querySelectorAll("[data-autosubmit]").forEach(function (el) {
    el.addEventListener("change", function () { el.form.submit(); });
  });

  // While a scan is running, poll until it finishes and then reload.
  if (document.body.dataset.scanning === "1") {
    setTimeout(function poll() {
      fetch("/scan/status").then(function (r) { return r.json(); }).then(function (d) {
        if (d.running) { setTimeout(poll, 1500); }
        else { window.location = "/?msg=" + encodeURIComponent(d.message || "Scan finished."); }
      }).catch(function () { setTimeout(poll, 3000); });
    }, 1500);
  }
})();
