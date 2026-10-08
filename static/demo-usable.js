(() => {
  "use strict";

  const diffGrid = document.getElementById("evalDiffGrid");
  if (diffGrid) {
    diffGrid.innerHTML = [
      ["Pair", "GLM 5.3", "lite (flash)"],
      ["Lane", "48 req", "44 req"],
      ["Avg tok/s", "23.1", "21.4"],
      ["Error rate", "0.0%", "2.2%"],
      ["Also", "Qwen3.8 router", "qwen3.8-27b-hermes"],
    ]
      .map(function (row) {
        return "<div class=\"diff-row\"><b>" + row[0] + "</b><span>" + row[1] + "</span><span>" + row[2] + "</span></div>";
      })
      .join("");
  }

  const dots = document.getElementById("deltaDots");
  if (dots) {
    dots.querySelectorAll("text").forEach(function (el) {
      if (el.textContent === "flash faster") el.textContent = "5.3 faster";
      if (el.textContent === "needed pro") el.textContent = "lite faster";
    });
  }

  // Rework carried (2026-09): redraw the router sankey with the live lanes the
  // plugin now uses — trafficLanes() buckets /recent by model family
  // (local / glm / qwen / nvidia) instead of the retired DSv4 flash/pro mock.
  const sankey = document.getElementById("sankey");
  if (sankey) {
    const lanes = [
      { id: "local", share: 0.46, req: 85, color: "#5a5a5a" },
      { id: "glm", share: 0.31, req: 57, color: "#6a6a6a" },
      { id: "qwen", share: 0.20, req: 37, color: "#7a7a7a" },
      { id: "nvidia", share: 0.03, req: 5, color: "var(--gold)" },
    ];
    let html = "";
    let y = 6;
    for (const lane of lanes) {
      const bw = Math.max(6, lane.share * (520 - 200));
      html += '<text x="0" y="' + (y + 16) + '" font-size="11" fill="currentColor" opacity="0.7">' + lane.id + "</text>";
      html += '<rect x="90" y="' + y + '" width="' + bw + '" height="26" rx="5" fill="' + lane.color + '">' +
        "<title>" + lane.id + " · " + Math.round(lane.share * 100) + "% · " + lane.req + " req</title></rect>";
      html += '<text x="' + (90 + bw + 8) + '" y="' + (y + 16) + '" font-size="11" fill="currentColor" opacity="0.7">' + lane.req + " req</text>";
      y += 40;
    }
    sankey.innerHTML = html;
  }
})();
