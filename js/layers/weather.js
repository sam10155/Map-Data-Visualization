/**
 * Weather overlay — fixed-grid national fetch.
 *
 *  • ONE fetch on mount: a fixed ~220-point grid covering all of Canada
 *    (chunked into ≤25-point requests). Pan/zoom make ZERO API calls.
 *  • Auto-refresh every 10 min while the layer is on.
 *  • Sub-layers: 🌡️ Temperature (filled cells + label), 💨 Wind arrows,
 *    💧 Precipitation circles, ⚡ Thunderstorm markers — independently toggleable.
 *  • On 429 the existing render is kept; legend shows backoff countdown.
 *
 * Source: Open-Meteo (free, no key, CORS-enabled).
 */

(function () {
  const TTL_MS = 10 * 60 * 1000;
  const CHUNK = 25;

  const CANADA = { latMin: 41.5, latMax: 83.2, lonMin: -141.0, lonMax: -52.5 };
  const MAX_CELLS = 225;   // hard cap → ≤9 chunked requests per refresh

  function makeCell(la, lo, d) {
    return {
      lat: +(la + d/2).toFixed(3), lon: +(lo + d/2).toFixed(3),
      bounds: [[la, lo], [la + d, lo + d]],
      labelPos: [la + d * 0.82, lo + d * 0.18],
    };
  }

  // Coarse national grid (mount-time default).
  function nationalGrid() {
    const cells = [];
    for (let la = CANADA.latMin; la < 56.5; la += 3.0)
      for (let lo = CANADA.lonMin; lo < CANADA.lonMax; lo += 3.0) cells.push(makeCell(la, lo, 3.0));
    for (let la = 56.5; la < CANADA.latMax; la += 6.0)
      for (let lo = CANADA.lonMin; lo < CANADA.lonMax; lo += 6.0) cells.push(makeCell(la, lo, 6.0));
    return cells;
  }

  // Viewport-fitted grid at zoom-appropriate resolution, capped at MAX_CELLS.
  function viewportGrid(m) {
    const z = m.getZoom();
    if (z <= 4) return nationalGrid();

    const b = m.getBounds();
    const s = Math.max(b.getSouth(), CANADA.latMin);
    const n = Math.min(b.getNorth(), CANADA.latMax);
    const w = Math.max(b.getWest(),  CANADA.lonMin);
    const e = Math.min(b.getEast(),  CANADA.lonMax);
    if (s >= n || w >= e) return nationalGrid();

    // Target cell size by zoom, then enlarge if it would exceed MAX_CELLS.
    let d = z >= 10 ? 0.1 : z >= 8 ? 0.25 : z >= 7 ? 0.5 : z >= 6 ? 1.0 : 2.0;
    const area = (n - s) * (e - w);
    while ((area / (d * d)) > MAX_CELLS) d *= 1.5;

    const s0 = Math.floor(s / d) * d;
    const w0 = Math.floor(w / d) * d;
    const cells = [];
    for (let la = s0; la < n; la += d)
      for (let lo = w0; lo < e; lo += d) cells.push(makeCell(la, lo, d));
    return cells.slice(0, MAX_CELLS);
  }

  const visible = { temp: true, wind: true, precip: true, storms: true };

  function tempColor(t) {
    const stops = [
      [-40,'#0d1b4c'],[-30,'#1e3a8a'],[-20,'#2563eb'],[-10,'#38bdf8'],
      [0,'#a7f3d0'],[10,'#fde047'],[20,'#fb923c'],[30,'#ef4444'],[40,'#7f1d1d']
    ];
    if (t <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0,c0]=stops[i-1],[t1,c1]=stops[i],f=(t-t0)/(t1-t0);
        const pa=parseInt(c0.slice(1),16),pb=parseInt(c1.slice(1),16);
        const ch=s=>Math.round(((pa>>s)&255)+(((pb>>s)&255)-((pa>>s)&255))*f);
        return '#'+[16,8,0].map(s=>ch(s).toString(16).padStart(2,'0')).join('');
      }
    }
    return stops[stops.length-1][1];
  }

  function describeCode(c) {
    if (c==null) return '';
    if (c===0) return 'Clear';
    if (c<=3) return 'Partly cloudy';
    if (c===45||c===48) return 'Fog';
    if (c>=51&&c<=57) return 'Drizzle';
    if (c>=61&&c<=67) return 'Rain';
    if (c>=71&&c<=77) return 'Snow';
    if (c>=80&&c<=82) return 'Rain showers';
    if (c>=85&&c<=86) return 'Snow showers';
    if (c>=95) return 'Thunderstorm';
    return `WMO ${c}`;
  }

  function windArrowSVG(dir, spd) {
    const toward=((dir??0)+180)%360;
    const len=Math.min(18,5+Math.sqrt(Math.max(0,spd))*1.8);
    const stroke=spd>=60?'#b91c1c':spd>=30?'#d97706':'#374151';
    return `<svg width="32" height="32" viewBox="-16 -16 32 32">
      <g transform="rotate(${toward})">
        <line x1="0" y1="${len/2}" x2="0" y2="${-len/2}" stroke="${stroke}" stroke-width="2" stroke-linecap="round" opacity="0.85"/>
        <polygon points="0,${-len/2-3} -3,${-len/2+2} 3,${-len/2+2}" fill="${stroke}" opacity="0.85"/>
      </g></svg>`;
  }

  function legendHTML() {
    const ramp=[-40,-30,-20,-10,0,10,20,30,40].map(t=>`<span style="background:${tempColor(t)}" title="${t}°C"></span>`).join('');
    return `<div class="overlay-legend">
      <div class="overlay-legend-title">🌡️ Weather <small>(Open-Meteo)</small></div>
      <div class="temp-ramp">${ramp}</div>
      <div class="temp-labels"><span>-40°C</span><span>0°C</span><span>+40°C</span></div>
      <div class="wx-row">↗ arrow → wind · <span class="precip-dot"></span> precip · ⚡ storm</div>
      <div class="wx-row" id="wx-status" style="color:#9ca3af;">loading…</div>
    </div>`;
  }

  async function fetchChunk(cells) {
    const url=`https://api.open-meteo.com/v1/forecast?latitude=${cells.map(c=>c.lat).join(',')}`+
      `&longitude=${cells.map(c=>c.lon).join(',')}`+
      `&current=temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,weather_code`+
      `&wind_speed_unit=kmh&timezone=UTC`;
    const res=await fetch(url);
    if (!res.ok) { const e=new Error(`HTTP ${res.status}`); e.status=res.status; throw e; }
    const json=await res.json();
    const arr=Array.isArray(json)?json:[json];
    return arr.map((row,i)=>({cell:cells[i],
      temp:row.current?.temperature_2m, precip:row.current?.precipitation,
      wspd:row.current?.wind_speed_10m, wdir:row.current?.wind_direction_10m,
      wcode:row.current?.weather_code}));
  }

  MapModes.register({
    id: 'weather',
    label: 'Weather',
    icon: '🌦️',
    build: () => {
      let panesMade=false;
      function ensurePanes(m) {
        if (panesMade) return;
        ['wxTemp','wxWind','wxPrecip','wxLabel','wxStorm'].forEach((p,i)=>{
          m.createPane(p); m.getPane(p).style.zIndex=405+i*5;
        });
        panesMade=true;
      }

      const gTemp=L.layerGroup(),gWind=L.layerGroup(),gPrecip=L.layerGroup(),
            gLabel=L.layerGroup(),gStorm=L.layerGroup();
      let legendCtl=null,mapRef=null,refreshTimer=null,fetching=false,backoffUntil=0;
      let currentGrid=null;

      function setStatus(msg){const el=document.getElementById('wx-status');if(el)el.textContent=msg;}

      function applyVisibility() {
        if (!mapRef) return;
        [['temp',gTemp],['temp',gLabel],['wind',gWind],['precip',gPrecip],['storms',gStorm]]
          .forEach(([k,g])=>{
            if (visible[k]) { if(!mapRef.hasLayer(g)) g.addTo(mapRef); }
            else if (mapRef.hasLayer(g)) mapRef.removeLayer(g);
          });
      }

      function renderCell(cell,d) {
        const tip=`<b>${d.temp!=null?d.temp.toFixed(1)+' °C':'—'}</b> · ${describeCode(d.wcode)}<br>`+
          `Wind ${Math.round(d.wspd??0)} km/h @ ${Math.round(d.wdir??0)}°<br>`+
          `Precip ${(d.precip??0).toFixed(1)} mm/h`;

        if (d.temp!=null) {
          L.rectangle(cell.bounds,{stroke:false,fillColor:tempColor(d.temp),fillOpacity:0.45,
            interactive:true,pane:'wxTemp'}).bindTooltip(tip,{sticky:true}).addTo(gTemp);
          L.marker(cell.labelPos,{icon:L.divIcon({className:'wx-temp-label',
            html:`<div>${Math.round(d.temp)}°</div>`,iconSize:[28,14],iconAnchor:[14,7]}),
            pane:'wxLabel',interactive:false,keyboard:false}).addTo(gLabel);
        }
        L.marker([cell.lat,cell.lon],{icon:L.divIcon({className:'wx-arrow',
          html:windArrowSVG(d.wdir,d.wspd??0),iconSize:[32,32],iconAnchor:[16,16]}),
          pane:'wxWind',keyboard:false}).bindTooltip(tip,{direction:'top',offset:[0,-10]}).addTo(gWind);
        if ((d.precip??0)>0.05) {
          L.circleMarker([cell.lat,cell.lon],{radius:5+Math.min(18,d.precip*5),
            color:'#0ea5e9',weight:2,fillColor:'#0ea5e9',fillOpacity:0.25,
            pane:'wxPrecip',interactive:true}).bindTooltip(tip,{sticky:true}).addTo(gPrecip);
        }
        if (d.wcode!=null&&d.wcode>=95) {
          L.marker([cell.lat,cell.lon],{icon:L.divIcon({className:'wx-storm',
            html:`<div class="wx-storm-glyph">⚡</div>`,iconSize:[24,24],iconAnchor:[12,12]}),
            pane:'wxStorm',keyboard:false}).bindTooltip(`⚡ ${describeCode(d.wcode)}<br>${tip}`,
            {direction:'top',offset:[0,-10]}).addTo(gStorm);
        }
      }

      async function loadGrid(grid, label) {
        if (fetching) return;
        const now=Date.now();
        if (now<backoffUntil) {
          setStatus(`rate-limited — retry in ${Math.ceil((backoffUntil-now)/1000)}s`);
          return;
        }
        fetching=true;
        currentGrid=grid;
        const total=grid.length;
        let loaded=0,cleared=false;
        setStatus(`${label}: loading 0/${total} cells…`);
        try {
          for (let i=0;i<total;i+=CHUNK) {
            const chunk=grid.slice(i,i+CHUNK);
            let rows;
            try { rows=await fetchChunk(chunk); }
            catch (e) {
              if (e.status===429) {
                backoffUntil=Date.now()+90000;
                setStatus(`rate-limited at ${loaded}/${total} — keeping ${cleared?loaded:'previous'}; retry in 90s`);
                return;
              }
              console.warn('[weather] chunk failed',e);
              setStatus(`chunk error (${e.message}) — ${loaded}/${total} cells`);
              continue;
            }
            if (!cleared) { [gTemp,gWind,gPrecip,gLabel,gStorm].forEach(g=>g.clearLayers()); cleared=true; }
            rows.forEach(r=>renderCell(r.cell,r));
            loaded+=rows.length;
            setStatus(`${label}: ${loaded}/${total} cells…`);
          }
          setStatus(`${label} · ${loaded} cells · ↻ to re-fit grid · auto-refresh ${TTL_MS/60000} min`);
        } finally { fetching=false; }
      }

      function loadNational() { return loadGrid(nationalGrid(), 'national'); }
      function loadViewport() {
        if (!mapRef) return;
        const g = viewportGrid(mapRef);
        const label = mapRef.getZoom() <= 4 ? 'national' : `z${mapRef.getZoom()} viewport`;
        return loadGrid(g, label);
      }
      function reloadCurrent() {
        return currentGrid ? loadGrid(currentGrid, 'refresh') : loadNational();
      }

      function controls() {
        const wrap=document.createElement('div');
        [['temp','🌡️ Temp'],['wind','💨 Wind'],['precip','💧 Precip'],['storms','⚡ Storms']]
          .forEach(([k,label])=>{
            const lab=document.createElement('label');
            lab.className='mapmode-sub-item';
            lab.innerHTML=`<input type="checkbox" ${visible[k]?'checked':''}> ${label}`;
            lab.querySelector('input').onchange=e=>{visible[k]=e.target.checked;applyVisibility();};
            wrap.appendChild(lab);
          });
        const btnRow=document.createElement('div');
        btnRow.style.cssText='display:flex;gap:4px;margin-top:4px;';
        const mkBtn=(txt,fn)=>{
          const b=document.createElement('button');
          b.style.cssText='flex:1;border:1px solid #d1d5db;border-radius:4px;background:white;padding:3px 6px;font-size:11px;cursor:pointer;';
          b.textContent=txt; b.onclick=()=>{backoffUntil=0;fn();};
          return b;
        };
        btnRow.appendChild(mkBtn('↻ Fit view',loadViewport));
        btnRow.appendChild(mkBtn('🌐 National',loadNational));
        wrap.appendChild(btnRow);
        return wrap;
      }

      return {
        mount(m) {
          mapRef=m; ensurePanes(m);
          [gTemp,gWind,gPrecip,gLabel,gStorm].forEach(g=>g.addTo(m));
          legendCtl=L.control({position:'bottomleft'});
          legendCtl.onAdd=()=>{const d=L.DomUtil.create('div');d.innerHTML=legendHTML();return d;};
          legendCtl.addTo(m);
          applyVisibility();
          loadNational();
          refreshTimer=setInterval(reloadCurrent,TTL_MS);
        },
        unmount(m) {
          if (refreshTimer) {clearInterval(refreshTimer);refreshTimer=null;}
          [gTemp,gWind,gPrecip,gLabel,gStorm].forEach(g=>{g.clearLayers();if(m.hasLayer(g))m.removeLayer(g);});
          if (legendCtl) {m.removeControl(legendCtl);legendCtl=null;}
          mapRef=null;
        },
        // No refresh on pan/zoom — grid is national and persistent.
        controls,
      };
    }
  });
})();
