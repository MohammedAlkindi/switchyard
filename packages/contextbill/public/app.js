document.querySelectorAll("[data-copy]").forEach(function (b) {
  b.addEventListener("click", function () {
    var t = b.getAttribute("data-copy");
    var ok = function () { var w = b.textContent; b.textContent = "Copied"; setTimeout(function () { b.textContent = w; }, 1300); };
    if (navigator.clipboard) { navigator.clipboard.writeText(t).then(ok, ok); } else { ok(); }
  });
});
