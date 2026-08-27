/**
 * 🌦️ Weather overlay — GeoMet WMS rasters + timeline scrubber.
 *
 *  Windy/MSN-style visuals from ECCC MSC GeoMet (keyless, CORS-open image
 *  tiles — no request limits; one layer per GetMap is a GeoMet rule):
 *   • 🌡 Temp   — HRDPS 2.5 km smooth colour field (TEMPERATURE-LINEAR),
 *                 GDPS 15 km beyond +48 h.
 *   • 💨 Wind   — wind-speed raster + server-rendered arrows (km/h).
 *   • 🌧 Precip — three time segments: observed RADAR (6-min frames, 3 h
 *                 back) → radar extrapolation nowcast (to +72 min) →
 *                 model precip rate (HRDPS then GDPS).
 *   • ⚡ Lightning — CLDN strike density (observed only; hidden when the
 *                 timeline is in the future).
 *   • 📍 Values — the legacy Open-Meteo point grid (numbers/arrows/
 *                 circles), OFF by default so pan/zoom costs no API calls.
 *
 *  Timeline: −3 h (radar) → now → +84 h (hourly; capped at GDPS's hourly
 *  extent — its 3-hourly far range needs run-aligned times, not worth the
 *  NoMatch risk). Off-grid TIME values return XML exceptions, so all
 *  times snap to each layer's step. Layer names verified 2026-08 (GeoMet
 *  is mid-rename; GDPS.ETA_* is gone — use GDPS_15km_*).
 */

(function () {
  const TTL_MS = 10 * 60 * 1000;
  const CHUNK = 25;

  const GEOMET = 'https://geo.weather.gc.ca/geomet';
  const MAX_FCST_MIN = 84 * 60;       // GDPS hourly extent
  const RADAR_BACK_MIN = 180;         // radar history
  const PLAY_MS = 800;

  const CANADA = { latMin: 41.5, latMax: 83.2, lonMin: -141.0, lonMax: -52.5 };
  const MAX_CELLS = 225;

  function makeCell(la, lo, d) {
    return {
      lat: +(la + d/2).toFixed(3), lon: +(lo + d/2).toFixed(3),
      bounds: [[la, lo], [la + d, lo + d]],
      labelPos: [la + d * 0.82, lo + d * 0.18],
    };
  }

  function nationalGrid() {
    const cells = [];
    for (let la = CANADA.latMin; la < 56.5; la += 3.0)
      for (let lo = CANADA.lonMin; lo < CANADA.lonMax; lo += 3.0) cells.push(makeCell(la, lo, 3.0));
    for (let la = 56.5; la < CANADA.latMax; la += 6.0)
      for (let lo = CANADA.lonMin; lo < CANADA.lonMax; lo += 6.0) cells.push(makeCell(la, lo, 6.0));
    return cells;
  }

  function viewportGrid(m) {
    const z = m.getZoom();
    if (z <= 4) return nationalGrid();
    const b = m.getBounds();
    const s = Math.max(b.getSouth(), CANADA.latMin);
    const n = Math.min(b.getNorth(), CANADA.latMax);
    const w = Math.max(b.getWest(),  CANADA.lonMin);
    const e = Math.min(b.getEast(),  CANADA.lonMax);
    if (s >= n || w >= e) return nationalGrid();
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

  const visible = { temp: true, wind: true, precip: true, lightning: true, values: false };

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

  // ---- timeline: index → minutes offset from now ----
  function buildTimeline() {
    const steps = [];
    for (let m = -RADAR_BACK_MIN; m < 0; m += 12) steps.push(m);
    steps.push(0);
    for (let h = 1; h <= MAX_FCST_MIN / 60; h++) steps.push(h * 60);
    return steps;
  }
  const TIMELINE = buildTimeline();
  const NOW_IDX = TIMELINE.indexOf(0);

  const isoZ = d => d.toISOString().slice(0, 19) + 'Z';
  function snapTime(tMin, stepMin, latencyMin) {
    const t = new Date(Date.now() + (tMin - (latencyMin || 0)) * 60000);
    t.setUTCSeconds(0, 0);
    t.setUTCMinutes(Math.floor(t.getUTCMinutes() / stepMin) * stepMin);
    return isoZ(t);
  }
  function hourTime(tMin) {
    const t = new Date(Date.now() + tMin * 60000);
    t.setUTCMinutes(0, 0, 0);
    return isoZ(t);
  }

  // Raster definition per toggle at a timeline position (minutes from now).
  function rasterDefs(tMin) {
    const past = tMin <= 0;
    const hrdps = tMin <= 48 * 60;
    const defs = {};
    defs.temp = {
      name: hrdps ? 'HRDPS-WEonG_2.5km_AirTemp' : 'GDPS_15km_AirTemp_2m',
      style: 'TEMPERATURE-LINEAR', opacity: 0.55,
      time: hourTime(Math.max(tMin, 0)),
    };
    defs.wspd = {
      name: hrdps ? 'HRDPS-WEonG_2.5km_WindSpeed' : 'GDPS_15km_WindSpeed_10m',
      style: 'WINDSPEEDKMH-LINEAR', opacity: 0.5,
      time: hourTime(Math.max(tMin, 0)),
    };
    defs.warrow = {
      name: hrdps ? 'HRDPS.CONTINENTAL_UU' : 'GDPS_15km_Winds_10m',
      style: 'WINDARROWKMH', opacity: 0.9,
      time: hourTime(Math.max(tMin, 0)),
    };
    if (past) {
      defs.precip = { name: 'RADAR_1KM_RRAI', style: 'Radar-Rain_14colors',
        opacity: 0.8, time: snapTime(tMin, 6, 12) };
    } else if (tMin <= 72) {
      defs.precip = { name: 'Radar_1km_RainPrecipRate-Extrapolation',
        style: 'Radar-Rain_14colors', opacity: 0.8, time: snapTime(tMin, 6, 0) };
    } else {
      defs.precip = {
        name: hrdps ? 'HRDPS.CONTINENTAL_RT' : 'GDPS_15km_PrecipRate',
        style: 'PRECIPPRTMMH-LINEAR', opacity: 0.65, time: hourTime(tMin) };
    }
    defs.lightning = past
      ? { name: 'Lightning_2.5km_Density', style: 'Lightning',
          opacity: 0.9, time: snapTime(tMin, 10, 20) }
      : null;   // observed-only — no forecast product
    return defs;
  }

  // Precipitation ramp sampled from GeoMet's Radar-Rain_14colors style so
  // the legend matches the tiles (light → heavy).
  const PRECIP_RAMP = ['#92c9fe','#33a9fe','#00c3bf','#00e585','#00cb00','#007700',
                       '#9fc500','#fefe00','#feb400','#fe6600','#fe0000','#fe0146',
                       '#c31eb6','#8722ba','#4a006f'];

  function legendHTML() {
    const tramp=[-40,-30,-20,-10,0,10,20,30,40].map(t=>`<span style="background:${tempColor(t)}" title="${t}°C"></span>`).join('');
    const pramp=PRECIP_RAMP.map(c=>`<span style="background:${c}"></span>`).join('');
    return `<div class="overlay-legend">
      <div class="overlay-legend-title">🌦️ Weather</div>
      <div class="temp-ramp">${tramp}</div>
      <div class="temp-labels"><span>-40°C</span><span>0°C</span><span>+40°C</span></div>
      <div class="temp-ramp">${pramp}</div>
      <div class="temp-labels"><span>light rain</span><span>heavy</span></div>
      <div class="wx-row" id="wx-status" style="color:#9ca3af;">loading…</div>
      <div class="wx-row">hover map for values · click for local forecast</div>
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
        ['wxRaster','wxRasterTop','wxTemp','wxWind','wxPrecip','wxLabel','wxStorm'].forEach((p,i)=>{
          m.createPane(p); m.getPane(p).style.zIndex=396+i*3;
        });
        panesMade=true;
      }

      const gTemp=L.layerGroup(),gWind=L.layerGroup(),gPrecip=L.layerGroup(),
            gLabel=L.layerGroup(),gStorm=L.layerGroup();
      const valueGroups=[gTemp,gWind,gPrecip,gLabel,gStorm];
      let legendCtl=null,mapRef=null,refreshTimer=null,retimeTimer=null;
      let fetching=false,backoffUntil=0,currentGrid=null,gridLoaded=false;
      let tIdx=NOW_IDX;
      const wms={};   // toggle-key → {layer, name}

      function setStatus(msg){const el=document.getElementById('wx-status');if(el)el.innerHTML=msg;}

      // ---- WMS raster management (one layer per request — GeoMet rule) ----
      function ensureWms(key, def, pane) {
        if (!mapRef) return;
        if (!def) { removeWms(key); return; }
        const cur = wms[key];
        if (cur && cur.name === def.name) {
          cur.layer.setParams({ time: def.time });
          return;
        }
        removeWms(key);
        const layer = L.tileLayer.wms(GEOMET, {
          layers: def.name, styles: def.style, format: 'image/png',
          transparent: true, version: '1.3.0', opacity: def.opacity,
          time: def.time, pane,
          attribution: 'ECCC GeoMet',
        }).addTo(mapRef);
        wms[key] = { layer, name: def.name };
      }
      function removeWms(key) {
        if (wms[key]) { if (mapRef.hasLayer(wms[key].layer)) mapRef.removeLayer(wms[key].layer); delete wms[key]; }
      }

      function applyTime() {
        const tMin = TIMELINE[tIdx];
        const defs = rasterDefs(tMin);
        ensureWms('temp',      visible.temp    ? defs.temp    : null, 'wxRaster');
        ensureWms('wspd',      visible.wind    ? defs.wspd    : null, 'wxRaster');
        ensureWms('warrow',    visible.wind    ? defs.warrow  : null, 'wxRasterTop');
        ensureWms('precip',    visible.precip  ? defs.precip  : null, 'wxRasterTop');
        ensureWms('lightning', visible.lightning ? defs.lightning : null, 'wxRasterTop');

        const src = tMin<0?'radar (observed)':tMin===0?'radar (latest)':tMin<=72?'radar nowcast':tMin<=2880?'HRDPS 2.5 km forecast':'GDPS 15 km forecast';
        setStatus(`🌧 ${src}${visible.lightning&&tMin>0?' · ⚡ observed-only (hidden in forecast)':''}`);
      }

      // ---- hover readout (WMS GetFeatureInfo on the active rasters) ----
      let hoverT=null, hoverTip=null;
      async function gfiValue(name, time, latlng) {
        const d=0.06;
        const url=`${GEOMET}?service=WMS&version=1.3.0&request=GetFeatureInfo`+
          `&layers=${encodeURIComponent(name)}&query_layers=${encodeURIComponent(name)}`+
          `&info_format=application/json&crs=EPSG:4326`+
          `&bbox=${(latlng.lat-d).toFixed(4)},${(latlng.lng-d).toFixed(4)},${(latlng.lat+d).toFixed(4)},${(latlng.lng+d).toFixed(4)}`+
          `&width=41&height=41&i=20&j=20&time=${encodeURIComponent(time)}`;
        const res=await fetch(url);
        if (!res.ok) return null;
        const j=await res.json();
        return j?.features?.[0]?.properties?.value ?? null;
      }

      function onHover(e) {
        clearTimeout(hoverT);
        hoverT=setTimeout(async ()=>{
          if (!mapRef || WxTimeline.isPlaying()) return;
          const tMin=TIMELINE[tIdx];
          const defs=rasterDefs(tMin);
          const jobs=[];
          if (visible.temp)   jobs.push(gfiValue(defs.temp.name, defs.temp.time, e.latlng).then(v=>v!=null?`🌡 ${v.toFixed(1)} °C`:null));
          if (visible.wind)   jobs.push(gfiValue(defs.wspd.name, defs.wspd.time, e.latlng).then(v=>v!=null?`💨 ${Math.round(v*3.6)} km/h`:null));
          if (visible.precip && tMin<=0)
                              jobs.push(gfiValue(defs.precip.name, defs.precip.time, e.latlng).then(v=>v!=null&&v>0?`🌧 ${(+v).toFixed(1)} mm/h`:null));
          const parts=(await Promise.all(jobs)).filter(Boolean);
          if (!mapRef || !parts.length) { if(hoverTip){mapRef?.removeLayer(hoverTip);hoverTip=null;} return; }
          if (!hoverTip) {
            hoverTip=L.tooltip({className:'wx-hover',direction:'top',offset:[0,-8],opacity:0.95});
          }
          hoverTip.setLatLng(e.latlng).setContent(parts.join('<br>'));
          if (!mapRef.hasLayer(hoverTip)) hoverTip.addTo(mapRef);
        },350);
      }
      function onHoverOut() {
        clearTimeout(hoverT);
        if (hoverTip && mapRef) { mapRef.removeLayer(hoverTip); hoverTip=null; }
      }

      // ---- click → MSN-style local forecast popup ----
      const WMO_EMOJI = c => c==null?'❔':c===0?'☀️':c<=2?'🌤️':c===3?'☁️':(c===45||c===48)?'🌫️'
        :(c>=51&&c<=57)?'🌦️':(c>=61&&c<=67)?'🌧️':(c>=71&&c<=77)?'🌨️':(c>=80&&c<=82)?'🌧️'
        :(c>=85&&c<=86)?'🌨️':c>=95?'⛈️':'❔';

      async function onMapClick(e) {
        if (!mapRef) return;
        const { lat, lng } = e.latlng;
        const popup=L.popup({minWidth:270,className:'wx-popup'})
          .setLatLng(e.latlng)
          .setContent('<div style="padding:8px;">fetching local forecast…</div>')
          .openOn(mapRef);
        try {
          const [wx, place] = await Promise.all([
            fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}`+
              `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m`+
              `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`+
              `&wind_speed_unit=kmh&timezone=auto&forecast_days=5`).then(r=>r.json()),
            fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&localityLanguage=en`)
              .then(r=>r.json()).catch(()=>null),
          ]);
          const c=wx.current||{};
          const name=place?.locality||place?.city||place?.principalSubdivision||`${lat.toFixed(2)}, ${lng.toFixed(2)}`;
          const days=(wx.daily?.time||[]).map((d,i)=>{
            const wd=new Date(d+'T12:00').toLocaleDateString(undefined,{weekday:'short'});
            return `<div style="text-align:center;flex:1;">
              <div style="font-size:10px;color:#6b7280;">${wd}</div>
              <div style="font-size:16px;">${WMO_EMOJI(wx.daily.weather_code[i])}</div>
              <div style="font-size:10px;"><b>${Math.round(wx.daily.temperature_2m_max[i])}°</b> ${Math.round(wx.daily.temperature_2m_min[i])}°</div>
              ${wx.daily.precipitation_probability_max?.[i]!=null?`<div style="font-size:9px;color:#0ea5e9;">${wx.daily.precipitation_probability_max[i]}%</div>`:''}
            </div>`;
          }).join('');
          popup.setContent(`<div style="min-width:250px;">
            <div style="font-weight:600;">${eh(name)}</div>
            <div style="display:flex;align-items:center;gap:10px;margin:4px 0;">
              <span style="font-size:34px;">${WMO_EMOJI(c.weather_code)}</span>
              <span style="font-size:28px;font-weight:700;">${c.temperature_2m!=null?Math.round(c.temperature_2m)+'°C':'—'}</span>
              <span style="font-size:11px;color:#6b7280;">${describeCode(c.weather_code)}<br>feels like ${c.apparent_temperature!=null?Math.round(c.apparent_temperature)+'°':'—'}</span>
            </div>
            <div style="font-size:11px;color:#374151;">💨 ${Math.round(c.wind_speed_10m??0)} km/h · 💧 ${c.relative_humidity_2m??'—'}% RH · 🌧 ${(c.precipitation??0).toFixed(1)} mm</div>
            <div style="display:flex;gap:2px;margin-top:6px;border-top:1px solid #e5e7eb;padding-top:4px;">${days}</div>
            <div style="font-size:9px;color:#9ca3af;margin-top:2px;">Open-Meteo · 5-day outlook</div>
          </div>`);
        } catch(err) {
          popup.setContent(`<div style="padding:8px;">forecast unavailable (${eh(err.message)})</div>`);
        }
      }

      // ---- legacy Open-Meteo point grid (📍 Values toggle) ----
      function applyValueVisibility() {
        if (!mapRef) return;
        valueGroups.forEach(g=>{
          if (visible.values){ if(!mapRef.hasLayer(g)) g.addTo(mapRef); }
          else if (mapRef.hasLayer(g)) mapRef.removeLayer(g);
        });
        if (visible.values && !gridLoaded) { gridLoaded=true; loadNational(); }
      }

      function renderCell(cell,d) {
        const tip=`<b>${d.temp!=null?d.temp.toFixed(1)+' °C':'—'}</b> · ${describeCode(d.wcode)}<br>`+
          `Wind ${Math.round(d.wspd??0)} km/h @ ${Math.round(d.wdir??0)}°<br>`+
          `Precip ${(d.precip??0).toFixed(1)} mm/h`;
        if (d.temp!=null) {
          L.rectangle(cell.bounds,{stroke:false,fillColor:tempColor(d.temp),fillOpacity:0.30,
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
        try {
          for (let i=0;i<total;i+=CHUNK) {
            const chunk=grid.slice(i,i+CHUNK);
            let rows;
            try { rows=await fetchChunk(chunk); }
            catch (e) {
              if (e.status===429) { backoffUntil=Date.now()+90000; return; }
              console.warn('[weather] chunk failed',e);
              continue;
            }
            if (!cleared) { valueGroups.forEach(g=>g.clearLayers()); cleared=true; }
            rows.forEach(r=>renderCell(r.cell,r));
            loaded+=rows.length;
          }
        } finally { fetching=false; }
      }

      function loadNational() { return loadGrid(nationalGrid(), 'national'); }
      function reloadCurrent() {
        if (!visible.values) return;
        return currentGrid ? loadGrid(currentGrid, 'refresh') : loadNational();
      }

      function controls() {
        const wrap=document.createElement('div');
        [['temp','🌡️ Temp'],['wind','💨 Wind'],['precip','🌧 Precip / radar'],
         ['lightning','⚡ Lightning'],['values','📍 Station values']]
          .forEach(([k,label])=>{
            const lab=document.createElement('label');
            lab.className='mapmode-sub-item';
            lab.innerHTML=`<input type="checkbox" ${visible[k]?'checked':''}> ${label}`;
            lab.querySelector('input').onchange=e=>{
              visible[k]=e.target.checked;
              if (k==='values') applyValueVisibility(); else applyTime();
            };
            wrap.appendChild(lab);
          });
        return wrap;
      }

      return {
        mount(m) {
          mapRef=m; ensurePanes(m);
          legendCtl=L.control({position:'bottomleft'});
          legendCtl.onAdd=()=>{const d=L.DomUtil.create('div');d.innerHTML=legendHTML();return d;};
          legendCtl.addTo(m);
          tIdx=NOW_IDX;
          WxTimeline.show(m,'weather',{
            steps:TIMELINE, nowIndex:NOW_IDX, loopWhilePast:true,
            leftLabel:'−3 h radar', rightLabel:'+84 h forecast',
            onChange:(tMin,idx)=>{ tIdx=idx; applyTime(); },
          });
          applyValueVisibility();
          m.on('mousemove',onHover);
          m.on('mouseout',onHoverOut);
          m.on('click',onMapClick);
          refreshTimer=setInterval(reloadCurrent,TTL_MS);
          // radar/lightning extents advance — re-snap "now"-anchored times
          retimeTimer=setInterval(()=>{ if (TIMELINE[tIdx]<=72) applyTime(); },5*60000);
        },
        unmount(m) {
          WxTimeline.hide('weather');
          m.off('mousemove',onHover);
          m.off('mouseout',onHoverOut);
          m.off('click',onMapClick);
          onHoverOut();
          if (refreshTimer){clearInterval(refreshTimer);refreshTimer=null;}
          if (retimeTimer){clearInterval(retimeTimer);retimeTimer=null;}
          Object.keys(wms).forEach(removeWms);
          valueGroups.forEach(g=>{g.clearLayers();if(m.hasLayer(g))m.removeLayer(g);});
          gridLoaded=false;
          if (legendCtl){m.removeControl(legendCtl);legendCtl=null;}
          mapRef=null;
        },
        controls,
      };
    }
  });
})();
