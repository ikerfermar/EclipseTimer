# Checklist navegadores secundarios

## Objetivo
Ejecutar smoke de escenarios A-F fuera de baseline para detectar regresiones importantes.

## Matriz
- Android Firefox
- Android Edge
- iOS Chrome

## Campos por corrida
- Fecha:
- Tester:
- Dispositivo:
- SO y version:
- Navegador y version:

## Smoke A-F
Marcar una fila por navegador.

| Navegador | A GPS | B C1-C4 | C Alertas | D Voz | E Kiosk | F Segundo plano | Critico | Notas |
|---|---|---|---|---|---|---|---|---|
| Android Firefox |  |  |  |  |  |  |  |  |
| Android Edge |  |  |  |  |  |  |  |  |
| iOS Chrome |  |  |  |  |  |  |  |  |

Leyenda de celdas:
- PASS: cumple esperado
- DEG: cumple con degradacion esperada
- FAIL: fallo real
- NA: no aplica por plataforma

## Criterio de salida secundarios
- Sin bloqueadores criticos en navegadores secundarios.
- Si hay FAIL, registrar issue con severidad y reproducibilidad.
