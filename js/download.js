function downloadCSV() {
  const rows = [['Name','Operator','City','Province','Sector','Subcategory','Status','Capacity','Unit','Lat','Lon']];
  Object.values(markers).forEach(items => {
    items.forEach(({ marker, facility }) => {
      if (map.hasLayer(marker)) {
        rows.push([facility.name, facility.operator||'', facility.city, facility.province,
          facility.sector, facility.subcategory, normalizeStatus(facility.status),
          facility.capacity||0, facility.unit, facility.lat, facility.lon]);
      }
    });
  });
  const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'canada_industrial_capacity.csv';
  a.click();
}

async function downloadEdits() {
  if (!window.storage) {
    alert('Storage not available - no edits to download');
    return;
  }

  const edits = {
    version: '1.0',
    exportDate: new Date().toISOString(),
    positions: {},
    attributes: {},
    deletes: []
  };

  try {
    // Position Edits
    const posResult = await window.storage.list('marker-pos:');
    if (posResult && posResult.keys) {
      for (const key of posResult.keys) {
        const stored = await window.storage.get(key);
        if (stored?.value) {
          const data = JSON.parse(stored.value);
          edits.positions[data.name] = data;
        }
      }
    }

    // Attribute Edits
    const attrResult = await window.storage.list('marker-attr:');
    if (attrResult && attrResult.keys) {
      for (const key of attrResult.keys) {
        const stored = await window.storage.get(key);
        if (stored?.value) {
          const data = JSON.parse(stored.value);
          edits.attributes[data.name] = data;
        }
      }
    }

    // Deletions
    const delResult = await window.storage.list('delete:');
    if (delResult && delResult.keys) {
      for (const key of delResult.keys) {
        const stored = await window.storage.get(key);
        if (stored?.value === '1') {
          const name = key.replace('delete:marker-attr:', '').replace('delete:', '');
          edits.deletes.push(name);
        }
      }
    }

    const json = JSON.stringify(edits, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `canada-industrial-edits-${new Date().toISOString().slice(0,10)}.json`;
    a.click();

    const count = Object.keys(edits.positions).length + 
                  Object.keys(edits.attributes).length + 
                  edits.deletes.length;
    
    showSaveNotification(`Downloaded ${count} edits`, true);
  } catch (err) {
    console.error('Failed to download edits:', err);
    showSaveNotification('Failed to download edits', false);
  }
}