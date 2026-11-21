// Tema: "sistema" (padrão, segue o aparelho), "claro" ou "escuro". Roda no <head> para não piscar.
(function () {
  var K = "pp_tema", r = document.documentElement;
  function ler() { try { var v = localStorage.getItem(K); return v === "claro" || v === "escuro" ? v : "sistema"; } catch (e) { return "sistema"; } }
  function aplicar(v) { r.setAttribute("data-tema", v); }
  aplicar(ler());
  window.ppTema = {
    atual: ler,
    definir: function (v) { try { localStorage.setItem(K, v); } catch (e) {} aplicar(v); },
    ligar: function (sel) { if (!sel) return; sel.value = ler(); sel.addEventListener("change", function () { window.ppTema.definir(sel.value); }); }
  };
})();
