# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_submodules, collect_data_files, copy_metadata

# rdflib/pyshacl register parsers, serializers and SPARQL via lazy module-path
# strings (e.g. 'rdflib.plugins.serializers.turtle') imported with importlib at
# runtime. PyInstaller's static analysis never sees those, so a bare
# hiddenimports=['rdflib','pyshacl'] bundles only the top-level package: import
# succeeds (capabilities reports available) but g.parse/serialize(format='turtle')
# and SHACL validate() fail at runtime. Collect every submodule, the bundled
# data files (pyshacl ships .ttl rule graphs), and dist metadata explicitly.
_semantic_hiddenimports = (
    collect_submodules('rdflib')
    + collect_submodules('pyshacl')
)
_semantic_datas = (
    collect_data_files('rdflib')
    + collect_data_files('pyshacl')
    + copy_metadata('rdflib')
    + copy_metadata('pyshacl')
)

a = Analysis(
    ['run_backend.py'],
    pathex=[],
    binaries=[],
    datas=[('../dist', 'dist')] + _semantic_datas,
    hiddenimports=[
        'uvicorn.logging', 'uvicorn.loops', 'uvicorn.loops.auto',
        'uvicorn.protocols', 'uvicorn.protocols.http', 'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets', 'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan', 'uvicorn.lifespan.on', 'fastapi', 'pydantic',
        'starlette', 'anyio', 'anyio.from_thread',
        'crewai', 'langchain_community', 'langchain_ollama', 'rdflib', 'pyshacl',
        'sqlite3'
    ] + _semantic_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='autology-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
