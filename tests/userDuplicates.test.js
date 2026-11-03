/**
 * Prueba de los PERFILES REPETIDOS: (A) las reglas sueltas (services/userDuplicates.js), (B) las rutas reales de usuarios (routes/users.js: crear, revisar antes de crear
 * y editar) contra una base FALSA en memoria, y (C) la regla de las listas de conductores del panel (utils/userProfiles.ts). No toca la base de datos real y todos los
 * nombres, correos y RUT de aquí son inventados.
 *
 * Cada consulta que la ruta hace se interpreta a mano; una consulta no prevista queda en S.unknown y hace fallar la prueba.
 *
 * Uso:   node tests/userDuplicates.test.js
 *        HARNESS_ROOT=<carpeta con otra copia del código> node tests/userDuplicates.test.js
 *        (otra copia = el código ANTERIOR, para comprobar que la prueba detecta el defecto, o el clon de Staging/Producción antes de subir)
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.resolve(process.env.HARNESS_ROOT || path.join(__dirname, '..'));
const load = (m) => require(require.resolve(m, { paths: [ROOT] }));
const express = load('express');
const jwt = load('jsonwebtoken');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-local';

// ───────────── base falsa ─────────────
let S;
const reset = () => { S = { users: [], inserted: [], updated: [], logs: [], unknown: [], profileSelects: 0 }; };
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const mk = (id, name, role, status = 'APROBADO', over = {}) => ({ id, name, role, status, email: `${id}@ejemplo.invalid`, personalRut: null, rut: null, password: 'x', ...over });
const R = (rows) => ({ rows, rowCount: rows.length });
async function run(text, params = []) {
    const q = norm(text); let m;
    if (q === 'SELECT id, name, role, status, email, "personalRut", rut FROM users') { S.profileSelects++; return R(S.users.map(u => ({ id: u.id, name: u.name, role: u.role, status: u.status, email: u.email, personalRut: u.personalRut, rut: u.rut }))); }
    if ((m = q.match(/^INSERT INTO users \((.+)\) VALUES \((.+)\)$/))) {
        const cols = m[1].split(',').map(c => c.trim().replace(/"/g, ''));
        const row = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
        S.inserted.push(row); S.users.push({ rut: null, personalRut: null, ...row }); return R([]);
    }
    if (/^INSERT INTO system_logs/.test(q)) { S.logs.push({ action: params[2] }); return R([]); }
    if ((m = q.match(/^UPDATE users SET (.+) WHERE id = \$(\d+)$/))) {
        const cols = m[1].split(',').map(c => c.trim().match(/^"([^"]+)" = \$\d+$/)[1]);
        const u = S.users.find(x => x.id === params[params.length - 1]); if (!u) return { rows: [], rowCount: 0 };
        cols.forEach((c, i) => { u[c] = params[i]; }); S.updated.push({ id: u.id, cols }); return { rows: [], rowCount: 1 };
    }
    if (q === 'SELECT * FROM users WHERE id = $1') { const u = S.users.find(x => x.id === params[0]); return R(u ? [{ ...u }] : []); }
    S.unknown.push(q); throw new Error('Consulta no prevista en la base falsa: ' + q.slice(0, 200));
}
const stub = (rel, exports) => { const p = require.resolve(path.join(ROOT, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('db.js', { query: (t, p) => run(t, p), getClient: async () => { throw new Error('no se usa'); } });

const tests = []; const t = (name, fn) => tests.push([name, fn]);
// En el código anterior (HARNESS_ROOT) este módulo no existe: las pruebas A fallan por eso, que es justo lo que debe verse.
let rules = null; try { rules = require(path.join(ROOT, 'services/userDuplicates.js')); } catch (e) { /* código anterior */ }
const tA = (name, fn) => t(name, () => { assert.ok(rules, 'no existe services/userDuplicates.js'); return fn(); });

// ───────────── A. reglas sueltas ─────────────
tA('A1 el nombre se compara sin mayúsculas, tildes ni espacios de más', () => {
    assert.strictEqual(rules.personKey('  JOSÉ   pérez '), rules.personKey('jose perez'));
    assert.strictEqual(rules.personKey('Ñuñoa Muñoz'), rules.personKey('nunoa munoz'));
    assert.notStrictEqual(rules.personKey('Jose Perez'), rules.personKey('Jose Perez Soto'));
});
tA('A2 mismo nombre y mismo rol (aprobado) → bloquea; sinónimos de rol cuentan como el mismo', () => {
    const existing = [mk('d1', 'María Soto', 'DRIVER')];
    for (const role of ['DRIVER', 'CHOFER', 'CONDUCTOR']) {
        const r = rules.findProfileConflicts({ name: 'MARIA  SOTO', role }, existing);
        assert.strictEqual(r.blocking.length, 1, role); assert.strictEqual(r.blocking[0].type, 'SAME_ROLE_NAME'); assert.strictEqual(r.warnings.length, 0);
    }
});
tA('A3 mismo nombre en OTRO rol del personal → solo avisa (una persona puede tener un perfil por rol)', () => {
    const r = rules.findProfileConflicts({ name: 'Diego Ficticio', role: 'DRIVER' }, [mk('a1', 'Diego Ficticio', 'ADMIN')]);
    assert.strictEqual(r.blocking.length, 0); assert.strictEqual(r.warnings.length, 1); assert.strictEqual(r.warnings[0].type, 'OTHER_ROLE');
    assert.ok(/Administrador/.test(r.warnings[0].message) && /Diego Ficticio/.test(r.warnings[0].message), r.warnings[0].message);
});
tA('A4 un cliente con el mismo nombre que un conductor NO se avisa (son cosas distintas)', () => {
    const r = rules.findProfileConflicts({ name: 'Tienda Falsa', role: 'CLIENT' }, [mk('d1', 'Tienda Falsa', 'DRIVER')]);
    assert.deepStrictEqual([r.blocking.length, r.warnings.length], [0, 0]);
});
tA('A5 un perfil ELIMINADO no bloquea, pero se avisa para poder reintegrarlo', () => {
    const r = rules.findProfileConflicts({ name: 'Pedro Inventado', role: 'DRIVER' }, [mk('d1', 'Pedro Inventado', 'DRIVER', 'ELIMINADO')]);
    assert.strictEqual(r.blocking.length, 0); assert.strictEqual(r.warnings[0].type, 'DELETED_SAME_ROLE'); assert.ok(/reintegrar/i.test(r.warnings[0].message));
    // un eliminado de OTRO rol no dice nada
    assert.deepStrictEqual(rules.findProfileConflicts({ name: 'Pedro Inventado', role: 'ADMIN' }, [mk('d1', 'Pedro Inventado', 'DRIVER', 'ELIMINADO')]), { blocking: [], warnings: [] });
});
tA('A6 deshabilitado y pendiente SÍ cuentan como existentes', () => {
    for (const status of ['DESHABILITADO', 'PENDIENTE']) {
        assert.strictEqual(rules.findProfileConflicts({ name: 'Luis Falso', role: 'DRIVER' }, [mk('d1', 'Luis Falso', 'DRIVER', status)]).blocking.length, 1, status);
    }
});
tA('A7 mismo RUT personal en el mismo rol del personal → bloquea aunque el nombre sea otro; en otro rol → avisa', () => {
    const existing = [mk('d1', 'Ana Primera', 'DRIVER', 'APROBADO', { personalRut: '12.345.678-5' })];
    const same = rules.findProfileConflicts({ name: 'Ana Segunda', role: 'DRIVER', personalRut: '123456785' }, existing);
    assert.strictEqual(same.blocking[0].type, 'SAME_ROLE_RUT');
    const other = rules.findProfileConflicts({ name: 'Ana Segunda', role: 'ADMIN', personalRut: '12345678-5' }, existing);
    assert.deepStrictEqual([other.blocking.length, other.warnings[0].type, other.warnings[0].matchedBy], [0, 'OTHER_ROLE', ['RUT']]);
});
tA('A8 los clientes comparten RUT (varias sucursales del mismo dueño): el RUT no los bloquea, el nombre idéntico sí', () => {
    const existing = [mk('c1', 'Sucursal Uno', 'CLIENT', 'APROBADO', { rut: '76.000.000-0', billingRut: '76.000.000-0' })];
    assert.deepStrictEqual(rules.findProfileConflicts({ name: 'Sucursal Dos', role: 'CLIENT', rut: '76000000-0', personalRut: '76000000-0' }, existing), { blocking: [], warnings: [] });
    assert.strictEqual(rules.findProfileConflicts({ name: 'sucursal uno', role: 'CLIENT' }, existing).blocking[0].type, 'SAME_ROLE_NAME');
});
tA('A9 el correo en uso bloquea sin importar mayúsculas, rol ni si el perfil está eliminado', () => {
    const existing = [mk('d1', 'Quien Sea', 'DRIVER', 'ELIMINADO', { email: 'Gente@Ejemplo.invalid' })];
    const r = rules.findProfileConflicts({ name: 'Otro Nombre', role: 'ADMIN', email: ' gente@ejemplo.INVALID ' }, existing);
    assert.strictEqual(r.blocking[0].type, 'EMAIL'); assert.ok(/correo/i.test(r.blocking[0].message));
});
tA('A10 al editar, el propio perfil no cuenta (excludeId); nombre vacío no coincide con nadie', () => {
    const existing = [mk('d1', 'Rosa Inventada', 'DRIVER')];
    assert.deepStrictEqual(rules.findProfileConflicts({ name: 'Rosa Inventada', role: 'DRIVER' }, existing, { excludeId: 'd1' }), { blocking: [], warnings: [] });
    assert.deepStrictEqual(rules.findProfileConflicts({ name: '   ', role: 'DRIVER' }, [mk('d2', '', 'DRIVER')]), { blocking: [], warnings: [] });
});
tA('A11 basura no rompe: listas nulas, perfiles nulos, rol sin definir', () => {
    assert.deepStrictEqual(rules.findProfileConflicts(null, null), { blocking: [], warnings: [] });
    assert.deepStrictEqual(rules.findProfileConflicts({ name: 'X Y', role: undefined }, [null, undefined, {}]), { blocking: [], warnings: [] });
});

// ───────────── B. rutas reales ─────────────
(async () => {
    const usersRouter = require(path.join(ROOT, 'routes/users.js'));
    const app = express(); app.use(express.json());
    app.use('/api/users', usersRouter);
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.on('listening', r));
    const port = server.address().port;
    const tok = (role, id = 'adm-1') => jwt.sign({ user: { id, role, name: id } }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const call = async (method, p, body, role = 'ADMIN', id = 'adm-1') => {
        const headers = { 'Content-Type': 'application/json' }; if (role) headers.Authorization = 'Bearer ' + tok(role, id);
        const r = await fetch(`http://127.0.0.1:${port}/api/users${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
        return { status: r.status, body: json };
    };
    const create = (over = {}) => call('POST', '', { name: 'PERSONA NUEVA', email: 'nueva@ejemplo.invalid', password: 'Clave-De-Prueba-1', role: 'DRIVER', phone: '+56900000000', ...over });

    t('B1 crear un perfil nuevo: 201, sin la bandera de confirmación como columna ni la contraseña en la respuesta', async () => {
        const r = await create({ confirmDuplicateWarning: true }); assert.strictEqual(r.status, 201, JSON.stringify(r.body) + S.unknown.join('|'));
        assert.strictEqual(S.inserted.length, 1); assert.ok(!('confirmDuplicateWarning' in S.inserted[0]), 'la bandera no es una columna'); assert.ok(!('password' in r.body));
        assert.strictEqual(S.inserted[0].status, 'APROBADO');
    });
    t('B2 mismo nombre y mismo rol (con otras mayúsculas, tildes y espacios): 409 y no se crea nada', async () => {
        S.users.push(mk('d1', 'José Pérez', 'DRIVER'));
        const r = await create({ name: '  JOSE   PEREZ ' });
        assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'DUPLICATE_PROFILE'); assert.ok(/Ya existe un perfil de Conductor/.test(r.body.message), r.body.message);
        assert.strictEqual(S.inserted.length, 0); assert.strictEqual(r.body.conflicts[0].profile.id, 'd1');
    });
    t('B3 la misma persona en otro rol: 409 CONFIRM_DUPLICATE sin crear; con la confirmación se crea', async () => {
        S.users.push(mk('a1', 'Diego Ficticio', 'ADMIN'));
        const first = await create({ name: 'DIEGO FICTICIO' });
        assert.strictEqual(first.status, 409); assert.strictEqual(first.body.code, 'CONFIRM_DUPLICATE'); assert.ok(/Administrador/.test(first.body.message)); assert.strictEqual(S.inserted.length, 0);
        const second = await create({ name: 'DIEGO FICTICIO', confirmDuplicateWarning: true });
        assert.strictEqual(second.status, 201, JSON.stringify(second.body)); assert.strictEqual(S.inserted.length, 1);
    });
    t('B4 el aviso no se salta con valores que no sean true (texto "true", 1)', async () => {
        S.users.push(mk('a1', 'Diego Ficticio', 'ADMIN'));
        for (const v of ['true', 1, 'si']) { const r = await create({ name: 'DIEGO FICTICIO', confirmDuplicateWarning: v }); assert.strictEqual(r.status, 409, String(v)); }
        assert.strictEqual(S.inserted.length, 0);
    });
    t('B5 un perfil eliminado del mismo rol: avisa y, confirmado, crea otro', async () => {
        S.users.push(mk('d1', 'Pedro Inventado', 'DRIVER', 'ELIMINADO'));
        const first = await create({ name: 'PEDRO INVENTADO' }); assert.strictEqual(first.status, 409); assert.strictEqual(first.body.code, 'CONFIRM_DUPLICATE'); assert.ok(/reintegrar/i.test(first.body.message));
        const second = await create({ name: 'PEDRO INVENTADO', confirmDuplicateWarning: true }); assert.strictEqual(second.status, 201);
    });
    t('B6 el correo repetido en otra capitalización se rechaza antes de llegar a la base', async () => {
        S.users.push(mk('d1', 'Alguien Más', 'DRIVER', 'APROBADO', { email: 'Nueva@Ejemplo.invalid' }));
        const r = await create(); assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'DUPLICATE_PROFILE'); assert.strictEqual(r.body.conflicts[0].type, 'EMAIL'); assert.strictEqual(S.inserted.length, 0);
    });
    t('B7 mismo RUT personal en otro conductor: 409 aunque el nombre cambie', async () => {
        S.users.push(mk('d1', 'Ana Primera', 'DRIVER', 'APROBADO', { personalRut: '12.345.678-5' }));
        const r = await create({ name: 'ANA SEGUNDA', personalRut: '12345678-5' });
        assert.strictEqual(r.status, 409); assert.strictEqual(r.body.conflicts[0].type, 'SAME_ROLE_RUT'); assert.strictEqual(S.inserted.length, 0);
    });
    t('B8 un cliente nuevo que comparte RUT con otras sucursales se crea', async () => {
        S.users.push(mk('c1', 'Sucursal Uno', 'CLIENT', 'APROBADO', { rut: '76000000-0' }));
        const r = await create({ name: 'SUCURSAL DOS', role: 'CLIENT', rut: '76000000-0', billingRut: '76000000-0' }); assert.strictEqual(r.status, 201, JSON.stringify(r.body)); assert.strictEqual(S.inserted.length, 1);
    });
    t('B9 revisar antes de crear: devuelve bloqueos y avisos, solo para administradores', async () => {
        S.users.push(mk('d1', 'José Pérez', 'DRIVER'), mk('a1', 'José Pérez', 'ADMIN'));
        const r = await call('POST', '/check-duplicates', { name: 'jose perez', role: 'DRIVER' });
        assert.strictEqual(r.status, 200); assert.strictEqual(r.body.blocking.length, 1); assert.strictEqual(r.body.warnings.length, 1);
        assert.strictEqual(r.body.blocking[0].profile.id, 'd1'); assert.strictEqual(r.body.warnings[0].type, 'OTHER_ROLE');
        assert.strictEqual((await call('POST', '/check-duplicates', { name: 'jose perez', role: 'DRIVER' }, 'DRIVER', 'drv-1')).status, 403);
        assert.strictEqual((await call('POST', '/check-duplicates', { name: 'x', role: 'DRIVER' }, null)).status, 401);
        assert.strictEqual((await call('POST', '/check-duplicates', { name: 'x' })).status, 400);
        assert.strictEqual(S.inserted.length, 0, 'revisar nunca crea');
    });
    t('B10 crear sigue siendo solo para administradores', async () => {
        assert.strictEqual((await call('POST', '', { name: 'X Y', email: 'x@y.invalid', password: 'Abcd1234', role: 'DRIVER' }, 'DRIVER', 'drv-1')).status, 403);
    });
    t('B11 editar: renombrar hasta repetir un perfil del mismo rol → 409 y no se actualiza', async () => {
        S.users.push(mk('d1', 'José Pérez', 'DRIVER'), mk('d2', 'Otro Distinto', 'DRIVER'));
        const r = await call('PUT', '/d2', { name: 'JOSE PEREZ' }); assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'DUPLICATE_PROFILE'); assert.strictEqual(S.updated.length, 0);
    });
    t('B12 editar: cambiar el rol a uno donde la persona ya existe → 409; a otro rol libre → 200', async () => {
        S.users.push(mk('a1', 'Diego Ficticio', 'ADMIN'), mk('d1', 'Diego Ficticio', 'DRIVER'), mk('x1', 'Rosa Libre', 'AUXILIAR'));
        assert.strictEqual((await call('PUT', '/d1', { role: 'ADMIN' })).status, 409);
        assert.strictEqual((await call('PUT', '/x1', { role: 'DRIVER' })).status, 200);
    });
    t('B13 editar sin tocar lo que identifica al perfil NO se vuelve a juzgar: un repetido que ya existía no queda intocable', async () => {
        S.users.push(mk('d1', 'Gemelo Uno', 'DRIVER'), mk('d2', 'Gemelo Uno', 'DRIVER'));       // repetido heredado
        S.profileSelects = 0;
        const phone = await call('PUT', '/d2', { phone: '+56911111111' }); assert.strictEqual(phone.status, 200); assert.strictEqual(S.profileSelects, 0, 'cambiar solo el teléfono no debe revisar duplicados');
        const same = await call('PUT', '/d2', { name: 'GEMELO UNO', phone: '+56922222222' }); assert.strictEqual(same.status, 200, 'mismo nombre con otras mayúsculas = no cambió');
    });
    t('B14 editar: cambiar solo el RUT a uno ya usado por otro conductor → 409; un nombre repetido heredado no estorba ese cambio', async () => {
        S.users.push(mk('d1', 'Ana Primera', 'DRIVER', 'APROBADO', { personalRut: '12345678-5' }), mk('d2', 'Ana Segunda', 'DRIVER'), mk('d3', 'Gemelo', 'DRIVER'), mk('d4', 'Gemelo', 'DRIVER'));
        assert.strictEqual((await call('PUT', '/d2', { personalRut: '12.345.678-5' })).status, 409);
        assert.strictEqual((await call('PUT', '/d4', { personalRut: '9.999.999-9' })).status, 200);
    });
    t('B15 un usuario que no es administrador solo edita lo suyo y no pasa por la revisión', async () => {
        S.users.push(mk('d1', 'José Pérez', 'DRIVER'), mk('d2', 'Otro Distinto', 'DRIVER'));
        S.profileSelects = 0;
        const r = await call('PUT', '/d2', { name: 'JOSE PEREZ' }, 'DRIVER', 'd2'); assert.strictEqual(r.status, 200); assert.strictEqual(S.profileSelects, 0);
    });

    // ───────────── C. listas de conductores del panel (utils/userProfiles.ts) ─────────────
    let util = null;
    try {
        const esbuild = load('esbuild');
        const src = fs.readFileSync(path.join(ROOT, 'utils/userProfiles.ts'), 'utf8');
        const code = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' }).code;
        const m = { exports: {} }; new Function('module', 'exports', code)(m, m.exports); util = m.exports;
    } catch (e) { console.log('(C se omite: no se pudo cargar utils/userProfiles.ts o esbuild: ' + e.message.split('\n')[0] + ')'); }
    if (util) {
        const U = (id, name, role, status = 'APROBADO', over = {}) => ({ id, name, role, status, email: id, ...over });
        const ids = (list) => list.map(u => u.id).join(',');
        t('C1 quien tiene perfil de conductor Y un perfil de administrador con permiso de entregar sale UNA vez, con su perfil de conductor', () => {
            const list = util.buildAssignableDrivers([U('a1', 'Diego Ficticio', 'ADMIN', 'APROBADO', { driverPermissions: { canDeliver: true } }), U('d1', 'DIEGO FICTICIO', 'DRIVER', 'APROBADO', { driverPermissions: { canDeliver: true } }), U('d2', 'Zoe Otra', 'DRIVER')]);
            assert.strictEqual(ids(list), 'd1,d2');
        });
        t('C2 un administrador SIN permiso de entregar NO aparece en las listas de conductores; con permiso explícito sí', () => {
            assert.strictEqual(ids(util.buildAssignableDrivers([U('a1', 'Admin Solo', 'ADMIN'), U('d1', 'Chofer Uno', 'DRIVER')])), 'd1');
            assert.strictEqual(ids(util.buildAssignableDrivers([U('a1', 'Admin Que Entrega', 'ADMIN', 'APROBADO', { driverPermissions: { canDeliver: true } }), U('d1', 'Chofer Uno', 'DRIVER')])), 'a1,d1');
        });
        t('C3 un perfil de conductor eliminado o no aprobado NO oculta al administrador que tiene permiso de entregar', () => {
            const admin = U('a1', 'Ana Ficticia', 'ADMIN', 'APROBADO', { driverPermissions: { canDeliver: true } });
            assert.strictEqual(ids(util.buildAssignableDrivers([admin, U('d1', 'Ana Ficticia', 'DRIVER', 'ELIMINADO')])), 'a1');
            assert.strictEqual(ids(util.buildAssignableDrivers([admin, U('d1', 'Ana Ficticia', 'DRIVER', 'DESHABILITADO')])), 'a1');
        });
        t('C4 dos conductores distintos con el mismo nombre se conservan los dos (no se oculta a una persona real)', () => {
            assert.strictEqual(ids(util.buildAssignableDrivers([U('d1', 'Juan Homónimo', 'DRIVER'), U('d2', 'Juan Homónimo', 'DRIVER')])), 'd1,d2');
        });
        t('C5 roles sinónimos y quien solo tiene el permiso de entregar', () => {
            const list = util.buildAssignableDrivers([U('a1', 'Admin Sinónimo', 'ADMINISTRADOR'), U('c1', 'Chofer Sinónimo', 'CHOFER'), U('k1', 'Conductor Sinónimo', 'CONDUCTOR'), U('x1', 'Auxiliar Que Entrega', 'AUXILIAR', 'APROBADO', { driverPermissions: { canDeliver: true } }), U('x2', 'Auxiliar Sin Permiso', 'AUXILIAR')]);
            assert.strictEqual(ids(list), 'x1,c1,k1');            // ordenados por nombre: Auxiliar Que Entrega, Chofer Sinónimo, Conductor Sinónimo (el administrador y el auxiliar sin permiso no entran)
        });
        t('C6 un auxiliar con permiso de entregar tampoco se repite si la persona ya tiene perfil de conductor', () => {
            assert.strictEqual(ids(util.buildAssignableDrivers([U('x1', 'Luis Doble', 'AUXILIAR', 'APROBADO', { driverPermissions: { canDeliver: true } }), U('d1', 'Luis Doble', 'DRIVER')])), 'd1');
        });
        t('C7 estados aprobados configurables (el escáner de despacho acepta más estados)', () => {
            const users = [U('d1', 'Chofer Activo', 'DRIVER', 'ACTIVO'), U('d2', 'Chofer Aprobado', 'DRIVER', 'APROBADO')];
            assert.strictEqual(ids(util.buildAssignableDrivers(users)), 'd2');
            assert.strictEqual(ids(util.buildAssignableDrivers(users, { approvedStatuses: ['APROBADO', 'APPROVED', 'ACTIVO'] })), 'd1,d2');
        });
        t('C8 las pestañas de administración: en la de auxiliares no se repite quien tiene perfil de auxiliar y de conductor con permiso', () => {
            const list = util.dropProfilesShadowedByRole([U('x1', 'Moni Doble', 'AUXILIAR'), U('d1', 'Moni Doble', 'DRIVER', 'APROBADO', { driverPermissions: { canDispatch: true } }), U('d2', 'Solo Conductor', 'DRIVER', 'APROBADO', { driverPermissions: { canDispatch: true } })], 'AUXILIAR');
            assert.strictEqual(ids(list), 'x1,d2');
        });
        t('C10 el caso del buscador de conductor: «Administrador Principal» y los demás administradores no aparecen, los conductores sí y en orden', () => {
            const list = util.buildAssignableDrivers([
                U('a0', 'Administrador Principal', 'ADMIN'), U('a1', 'Moisés Ficticio', 'ADMIN'), U('a2', 'Persona Doble', 'ADMIN'),
                U('d3', 'Anais Inventada', 'DRIVER'), U('d1', 'Alejandro Falso', 'DRIVER'), U('d2', 'Persona Doble', 'DRIVER'), U('d9', 'Chofer Eliminado', 'DRIVER', 'ELIMINADO'),
            ]);
            assert.strictEqual(ids(list), 'd1,d3,d2');            // Alejandro Falso, Anais Inventada, Persona Doble
        });
        t('C9 no modifica la lista original y tolera datos incompletos', () => {
            const users = [U('a1', 'Admin Solo', 'ADMIN'), { id: 'z', name: undefined, role: undefined, status: undefined }];
            const copy = JSON.stringify(users); util.buildAssignableDrivers(users); assert.strictEqual(JSON.stringify(users), copy);
        });
    }

    // ───────────── ejecutar ─────────────
    let ok = 0; const fails = [];
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    for (const [name, fn] of tests) {
        reset();
        try { await fn(); ok++; console.log('OK    ' + name); } catch (e) { fails.push(name); console.log('FALLA ' + name + '\n      ' + String(e.message).split('\n').slice(0, 3).join('\n      ') + (S.unknown.length ? '\n      consultas no previstas: ' + S.unknown.join(' | ') : '')); }
    }
    console.log(`\n${ok} de ${tests.length} pruebas OK`);
    server.close(); process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(2); });
