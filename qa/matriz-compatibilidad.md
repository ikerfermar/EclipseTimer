# Matriz de compatibilidad esperada

## APIs sensibles por plataforma

| API o feature | Android Chrome | Android Firefox | Android Edge | iOS Safari | iOS Chrome | Regla QA |
|---|---|---|---|---|---|---|
| Geolocation | Alto soporte | Alto soporte | Alto soporte | Alto soporte | Alto soporte sobre WebKit | Obligatorio baseline |
| Web Audio beep | Alto soporte | Alto soporte | Alto soporte | Soporte con restricciones de gesto y audio | Soporte con restricciones de gesto y audio | Obligatorio si API disponible |
| Speech Synthesis | Alto soporte | Medio-alto | Alto soporte | Medio-alto, dependiente de modo silencio | Medio-alto, dependiente de modo silencio | Obligatorio si API disponible |
| Vibration | Soporte | Soporte parcial | Soporte | No soportado | No soportado | Android obligatorio, iOS NA |
| Wake Lock screen | Soporte en Chromium moderno | Limitado | Soporte en Chromium moderno | No soportado | No soportado | Android obligatorio, iOS degradacion esperada |
| Fullscreen | Soporte | Soporte | Soporte | Pseudo-fullscreen segun navegador | Pseudo-fullscreen segun navegador | Valido en ambas plataformas |
| Notifications | Soporte con permiso | Soporte con permiso | Soporte con permiso | Restringido, mejor en PWA | Restringido, mejor en PWA | Secundario, no bloqueante en iOS navegador |

## Clasificacion de severidad QA
- Critico: datos astronomicos incorrectos o app inutilizable en baseline.
- Alto: feature obligatoria no usable en baseline.
- Medio: solo afecta secundario o hay workaround operativo.
- Bajo: defecto visual o de UX sin impacto funcional.
