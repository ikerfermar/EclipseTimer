# QA movil cross-browser - EclipseTimer

## Objetivo
Ejecutar una validacion manual completa por escenarios en Android e iOS con criterio minimo viable por plataforma.

## Baseline obligatorio
- Android: Chrome estable
- iOS: Safari estable

## Secundarios best-effort
- Android: Firefox, Edge
- iOS: Chrome

## Regla de aprobacion por plataforma
- Obligatorio en baseline: GPS, calculo C1-C4, modo prueba, kiosk/fullscreen, estabilidad UI.
- Audio/voz: obligatorio cuando la API del navegador lo permita.
- Vibracion y wake lock: obligatorios en Android; en iOS se registran como no aplica si no hay soporte nativo.
- Segundo plano: obligatorio en Android; en iOS debe reanudar correctamente al volver a foreground.

## Orden recomendado de ejecucion
1. Completar precondiciones en qa/checklist-baseline.md.
2. Ejecutar escenarios A-F en Android Chrome.
3. Ejecutar escenarios A-F en iOS Safari.
4. Repetir smoke A-F en navegadores secundarios con qa/checklist-secundarios.md.
5. Registrar defectos con qa/plantilla-reporte-incidencia.md o .github/ISSUE_TEMPLATE/qa-bug-report.md.
6. Consolidar decision final con qa/resumen-release.md.

## Tiempo estimado
- Baseline completo: 60-90 min
- Secundarios: 30-45 min
- Consolidacion: 15 min

## Evidencia minima por corrida
- Captura o video por cada escenario A-F.
- Version de SO, navegador y dispositivo.
- Estado final: Aprobado, Aprobado con degradacion, Bloqueado.
