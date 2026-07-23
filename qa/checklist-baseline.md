# Checklist baseline obligatorio

## Metadata de corrida
- Fecha:
- Tester:
- Build o commit:
- Dispositivo:
- SO y version:
- Navegador y version:
- Red: Wi-Fi o datos

## Precondiciones
- [ ] Permiso de ubicacion habilitado para el navegador.
- [ ] Audio multimedia activo.
- [ ] En iPhone, switch fisico de silencio desactivado.
- [ ] Bateria mayor a 50 por ciento.
- [ ] Notificaciones habilitadas si se van a validar.
- [ ] App cargada por HTTPS o localhost confiable.
- [ ] Coordenadas fallback disponibles: 42.5987, -5.5671, 838.

## Escenario A - GPS y recalc
Pasos:
1. Abrir app en frio.
2. Pulsar Usar mi ubicacion.
3. Confirmar estado de obtencion y resultado.
4. Pulsar Recalcular.

Esperado:
- [ ] Se obtiene ubicacion o mensaje claro de error.
- [ ] Si hay GPS, se muestra fuente GPS y precision.
- [ ] Si falla GPS, el flujo manual sigue disponible.

Resultado obtenido:
- Estado: [ ] Aprobado [ ] Aprobado con degradacion [ ] Fallo
- Evidencia:
- Notas:

## Escenario B - C1-C4
Pasos:
1. Con GPS o coordenadas manuales validas, revisar Contactos.
2. Verificar orden temporal.
3. Probar una ubicacion sin totalidad.

Esperado:
- [ ] En totalidad: C1 menor C2 menor C3 menor C4.
- [ ] Sin totalidad: C2 y C3 no visibles o no aplicables.
- [ ] Mensajes de parcial o no visible coherentes.

Resultado obtenido:
- Estado: [ ] Aprobado [ ] Aprobado con degradacion [ ] Fallo
- Evidencia:
- Notas:

## Escenario C - Alertas -30, -20, -10
Pasos:
1. Entrar en Modo de prueba x5.
2. Esperar secuencia de alertas.
3. Repetir en x20 para estres.

Esperado:
- [ ] Orden correcto: -30 luego -20 luego -10.
- [ ] Banner visible y cerrable en cada alerta.
- [ ] Beep audible cuando audio este disponible.
- [ ] Vibracion en Android.
- [ ] En iOS, vibracion puede ser no aplica.

Resultado obtenido:
- Estado: [ ] Aprobado [ ] Aprobado con degradacion [ ] Fallo
- Evidencia:
- Notas:

## Escenario D - Voz
Pasos:
1. Pulsar Probar voz.
2. Activar anuncios live.
3. Repetir evento de contacto en modo prueba.

Esperado:
- [ ] Voz se escucha cuando speech esta disponible.
- [ ] No hay cola de voz acumulada ni solapada.
- [ ] Si no hay soporte o esta silenciado, no rompe flujo.

Resultado obtenido:
- Estado: [ ] Aprobado [ ] Aprobado con degradacion [ ] Fallo
- Evidencia:
- Notas:

## Escenario E - Kiosk y fullscreen
Pasos:
1. Entrar en Pantalla completa.
2. Verificar ocultacion de secciones no criticas.
3. Salir con boton Salir o gesto del sistema.

Esperado:
- [ ] Entra sin errores.
- [ ] UI principal queda enfocada al cronometro.
- [ ] Sale y restaura vista normal.
- [ ] En iOS, pseudo-fullscreen se considera valido.

Resultado obtenido:
- Estado: [ ] Aprobado [ ] Aprobado con degradacion [ ] Fallo
- Evidencia:
- Notas:

## Escenario F - Segundo plano
Pasos:
1. Activar modo persistente.
2. Enviar app a segundo plano 2 a 5 minutos.
3. Volver a foreground.

Esperado Android:
- [ ] El temporizador sigue consistente.
- [ ] No hay congelamiento ni cierre de estado.

Esperado iOS:
- [ ] Reanuda correctamente al volver.
- [ ] Si hubo limitacion de background, queda documentada como degradacion.

Resultado obtenido:
- Estado: [ ] Aprobado [ ] Aprobado con degradacion [ ] Fallo
- Evidencia:
- Notas:

## Decision de corrida baseline
- Android Chrome: [ ] Aprobado [ ] Aprobado con degradacion [ ] Bloqueado
- iOS Safari: [ ] Aprobado [ ] Aprobado con degradacion [ ] Bloqueado
- Bloqueadores encontrados:
- Recomendacion final:
