// Interface strings. A book can override any key with "ui": { ... } in book.json.
export const UI = {
  en: {
    brand: 'PopBook · interactive pop-up book', popup: 'Pop-up book', lesson: 'Lesson', plan: 'Contents', howtoLab: 'HOW TO USE',
    howto: 'Touch the models on the right, answer the prediction, then lift the flap. A finished lesson gets its stamp. ▶ Demo gives a guided tour.',
    vocab: 'Vocabulary', predict: 'Predict first', why: 'WHY?', lift: 'Lift the flap', answerFirst: 'answer the prediction first', toSee: 'to see the answer',
    stamped: 'DONE', models: 'models', prediction: 'prediction', demo: 'Demo',
    touch: 'Touch a model to explore it.', run: 'Touch to start the clock.', clock: 'SIMULATED CLOCK', elapsed: 'ELAPSED',
    raceHelp: 'Touch a jar or a label: the clock runs for both machines at the same time.', done: 'done', d: 'd', mo: 'months', yr: 'years',
    logScale: 'LOGARITHMIC SCALE', linScale: 'LINEAR SCALE', logHelp: 'Each step is ×10: exponential growth becomes a straight line.',
    linHelp: 'On a linear scale the early values are squashed flat: the exponential explodes at the end.', growth: 'Dashed red line:', scale: 'Scale', grow: 'Grow the timeline',
    useSlider: 'Use the slider on the left page.', touchCurve: 'Touch the curve to read a value.',
    pipeline: 'PIPELINE', flowHelp: 'Press ▶ on the left page to send the token through every step, or touch a step.', runFlow: 'Run', levels: 'LEVELS',
    core1: '1 CORE', core2: '1 CORE · 2 THREADS', coreTip: 'One task at a time (two with hyperthreading). Touch to start / stop the scheduler.', waiting: 'Waiting for its turn in the scheduler queue.',
    gantt: 'GANTT CHART', simul: 'At human scale, the tasks seem to run at the same time.', oneAtTime: 'Only one task at a time: the OS switches between them.', startCore: 'Touch the core to start the scheduler.'
  },
  fr: {
    brand: 'PopBook · livre pop-up interactif', popup: 'Livre pop-up', lesson: 'Leçon', plan: 'Plan du cours', howtoLab: 'MODE D’EMPLOI',
    howto: 'Touchez les maquettes à droite, répondez à la prédiction, puis soulevez le rabat. Une leçon terminée reçoit son tampon. ▶ Démo fait la visite guidée.',
    vocab: 'Vocabulaire', predict: 'Prédisez d’abord', why: 'POURQUOI ?', lift: 'Soulevez le rabat', answerFirst: 'répondez d’abord à la prédiction', toSee: 'pour voir la réponse',
    stamped: 'VALIDÉ', models: 'maquettes', prediction: 'prédiction', demo: 'Démo',
    touch: 'Touchez une maquette pour l’explorer.', run: 'Touchez pour lancer le chrono.', clock: 'CHRONO SIMULÉ', elapsed: 'TEMPS ÉCOULÉ',
    raceHelp: 'Touchez un bocal ou une étiquette : le chrono défile pour les deux machines en même temps.', done: 'terminé', d: 'j', mo: 'mois', yr: 'ans',
    logScale: 'ÉCHELLE LOGARITHMIQUE', linScale: 'ÉCHELLE LINÉAIRE', logHelp: 'Chaque graduation vaut ×10 : une croissance exponentielle devient une droite.',
    linHelp: 'En linéaire, les premières valeurs sont écrasées au sol : l’exponentielle explose d’un coup.', growth: 'Pointillés rouges :', scale: 'Échelle', grow: 'Faire pousser la frise',
    useSlider: 'Utilisez le curseur sur la page de gauche.', touchCurve: 'Touchez la courbe pour lire une valeur.',
    pipeline: 'CHAÎNE DE TRAITEMENT', flowHelp: 'Appuyez sur ▶ à gauche pour faire passer le jeton par chaque étape, ou touchez une étape.', runFlow: 'Lancer', levels: 'NIVEAUX',
    core1: '1 CŒUR', core2: '1 CŒUR · 2 FILS', coreTip: 'Une seule tâche à la fois (deux avec l’hyperthreading). Touchez pour démarrer / arrêter l’ordonnanceur.', waiting: 'Attend son tour dans la file de l’ordonnanceur.',
    gantt: 'DIAGRAMME DE GANTT', simul: 'À l’échelle humaine, les tâches semblent tourner en même temps.', oneAtTime: 'Une seule tâche à la fois : le SE alterne.', startCore: 'Touchez le cœur pour démarrer l’ordonnanceur.'
  },
  ar: {
    brand: 'PopBook · كتاب منبثق تفاعلي', popup: 'كتاب منبثق', lesson: 'الدرس', plan: 'المحتويات', howtoLab: 'طريقة الاستعمال',
    howto: 'المس المجسمات على اليمين، أجب عن التوقع، ثم ارفع الغطاء. يحصل الدرس المكتمل على ختمه. ▶ عرض يقدم جولة موجهة.',
    vocab: 'المصطلحات', predict: 'توقّع أولاً', why: 'لماذا؟', lift: 'ارفع الغطاء', answerFirst: 'أجب عن التوقع أولاً', toSee: 'لرؤية الإجابة',
    stamped: 'تمّ', models: 'المجسمات', prediction: 'التوقع', demo: 'عرض',
    touch: 'المس مجسماً لاستكشافه.', run: 'المس لتشغيل العدّاد.', clock: 'عدّاد محاكى', elapsed: 'الوقت المنقضي',
    raceHelp: 'المس وعاءً أو بطاقة: يعمل العدّاد للجهازين في الوقت نفسه.', done: 'انتهى', d: 'ي', mo: 'أشهر', yr: 'سنوات',
    logScale: 'سلّم لوغاريتمي', linScale: 'سلّم خطّي', logHelp: 'كل تدريجة ×10: يصبح النمو الأسّي خطاً مستقيماً.',
    linHelp: 'في السلّم الخطي تنسحق القيم الأولى: ينفجر النمو الأسي في النهاية.', growth: 'الخط الأحمر المتقطع:', scale: 'السلّم', grow: 'تنمية الخط الزمني',
    useSlider: 'استعمل المنزلق في الصفحة الأخرى.', touchCurve: 'المس المنحنى لقراءة قيمة.',
    pipeline: 'سلسلة المعالجة', flowHelp: 'اضغط ▶ لتمرير الرمز عبر كل مرحلة، أو المس مرحلة.', runFlow: 'تشغيل', levels: 'المستويات',
    core1: 'نواة واحدة', core2: 'نواة · خيطان', coreTip: 'مهمة واحدة في كل مرة (اثنتان مع الـ Hyperthreading). المس للتشغيل / الإيقاف.', waiting: 'تنتظر دورها في طابور المجدول.',
    gantt: 'مخطط غانت', simul: 'على المقياس البشري تبدو المهام متزامنة.', oneAtTime: 'مهمة واحدة في كل مرة: النظام يتناوب بينها.', startCore: 'المس النواة لتشغيل المجدول.'
  }
};
