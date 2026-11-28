// fork: translations of the fork-only text, added to BH_STRINGS so they work like the rest.
// The window loads this as a plain script right after i18n-strings.js; in Node (main process,
// tests) i18n-strings.js requires it. Kept out of i18n-strings.js so upstream merges don't clash.
(function (apply) {
  if (typeof module !== 'undefined' && module.exports) module.exports = apply;
  else apply(BH_STRINGS);
})(function (S) {
  // Taskbar battery levels (fork Issue #16)
  Object.assign(S.pt, {
    'Taskbar battery levels': 'Níveis de bateria na barra de tarefas',
    "Show each connected device's icon and level next to the tray.": 'Mostra o ícone e o nível de cada dispositivo conectado ao lado da bandeja.',
  });
  Object.assign(S.es, {
    'Taskbar battery levels': 'Niveles de batería en la barra de tareas',
    "Show each connected device's icon and level next to the tray.": 'Muestra el icono y el nivel de cada dispositivo conectado junto a la bandeja.',
  });
  Object.assign(S.zh, {
    'Taskbar battery levels': '任务栏电量',
    "Show each connected device's icon and level next to the tray.": '在托盘旁显示每个已连接设备的图标和电量。',
  });
  Object.assign(S.he, {
    'Taskbar battery levels': 'רמות סוללה בשורת המשימות',
    "Show each connected device's icon and level next to the tray.": 'הצגת הסמל והרמה של כל מכשיר מחובר ליד המגש.',
  });
  Object.assign(S.ru, {
    'Taskbar battery levels': 'Заряд на панели задач',
    "Show each connected device's icon and level next to the tray.": 'Показывать значок и заряд каждого подключённого устройства рядом с треем.',
  });
});
