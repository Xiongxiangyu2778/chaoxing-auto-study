# -*- coding: utf-8 -*-
"""学习通作业助手 · 统一入口（chx）

把「开浏览器 / 导出题目 / 自动填答 / 归档」包成**非交互**子命令，
让 AI（WorkBuddy 等）和人工都能用同一条命令驱动整条流水线。

    python chx.py doctor                                   # 自检环境
    python chx.py status                                   # 查看当前工作区状态
    python chx.py browser                                  # 打开独立浏览器并停在课程页
    python chx.py browser --restart                        # 关掉旧窗口重新拉起
    python chx.py dump                                     # 导出当前作答页题目
    python chx.py listen                                   # 提取听力题音频+挖空工作单（转写后并入 blank）
    python chx.py fill                                     # 按 answers.json 自动填答（自动区分作业页/考试页）
    python chx.py archive "数据库原理与应用" "第三次作业"     # 归档
    python chx.py archive "数据库原理与应用"                 # 次数自动递增
    （考试专用填答脚本住在 ../考试/chaoxing_exam_fill.js，fill/exam 会自动调用）
    python chx.py auto                                     # 全自动：导出→AI答题→填答→归档
    python chx.py auto --course "数据库原理与应用" --seq "第三次作业"
    python chx.py auto --skip-ai                           # 不做 AI，直接填已有的 answers.json
    python chx.py exam                                     # 考试一条龙：逐题导出→AI答题→逐题填答→归档
    python chx.py exam --course "通用英语B" --seq "期末考试"
    python chx.py exam --transcript 考试听力转写.txt        # 听力题带转写稿作答
    python chx.py exam --skip-ai                           # 复用 answers.json，只填答+归档
    python chx.py llm                                      # 自检 AI key 能不能用（配完 key 先跑这个）

设计约定
--------
1. 所有子命令**不询问、不 pause**；缺参数直接报错并返回退出码 2。
2. 每个子命令最后都会打印一行 ``CHX_RESULT {json}``，供 AI 解析结构化结果。
3. 浏览器相关等待可用环境变量覆盖（见下），默认值对「人工双击」保持友好。
4. dump / fill **自己确保浏览器就绪**：没开就自动拉起来，不需要你提前开窗口。

环境变量
--------
CHX_WAIT_SECONDS        等待你打开作答页的秒数（默认 600）
CHX_KEEP_OPEN_SECONDS   动作结束后保持浏览器打开的秒数（默认 dump 60 / fill 1500）
CHX_AFTER=exit          动作结束立即退出、且**不关浏览器窗口**（AI 调用推荐，chx.py 已默认）
CHX_ARCHIVE_ROOT        归档根目录（默认：工具文件夹上一级目录下的 课程作业）
CHX_PORT                调试端口（默认 9222）
CHX_PROFILE             登录态目录（默认 %USERPROFILE%\\edge-quiz-profile）
CHX_START_URL           自动拉起浏览器时打开的页面（默认学习通课程列表）
CHX_ALLOW_MISMATCH=1    跳过「答案数量与题目模板」的一致性检查

AI 配置（auto / exam 才需要）
----------------------
复制 llm_config.example.json 为 llm_config.json，填 api_key 即可（OpenAI 兼容格式）。
**默认走智谱 glm-5.3-flash**（5.3 最新代，自动降级 glm-5.3-flashx / glm-4.5-flash 免费）：
    智谱      base_url=https://open.bigmodel.cn/api/paas/v4 model=glm-4.5-flash  ← 免费，推荐
若想换付费的（更聪明）：
    DeepSeek  base_url=https://api.deepseek.com/v1        model=deepseek-chat
    通义千问  base_url=https://dashscope.aliyuncs.com/compatible-mode/v1  model=qwen-plus
    Kimi      base_url=https://api.moonshot.cn/v1         model=moonshot-v1-8k
也可用环境变量临时覆盖：CHX_LLM_KEY / CHX_LLM_BASE / CHX_LLM_MODEL

启动的浏览器是**脱离进程**的（DETACHED_PROCESS）：脚本跑完、甚至被 AI 强杀，
窗口都不会跟着消失。
"""

import glob
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))      # ...\\学习通作业助手\\写作业
ROOT = os.path.dirname(HERE)                            # ...\\学习通作业助手

DUMP_JS = os.path.join(HERE, 'chaoxing_dump.js')
FILL_JS = os.path.join(HERE, 'chaoxing_fill.js')
ARCHIVE_PY = os.path.join(HERE, 'archive_homework.py')

# 考试模式（2026-10-18 独立成文件夹）：脚本在 ..\考试\，工作文件仍在 写作业\
EXAM_DIR = os.path.join(os.path.dirname(HERE), '考试')
EXAM_FILL_JS = os.path.join(EXAM_DIR, 'chaoxing_exam_fill.js')
EXAM_UNITS = os.path.join(HERE, '考试单元.json')
# 听力转写稿候选（考试/作业通用，有就自动喂给 AI）
TRANSCRIPT_FILES = ['考试听力转写.txt', '听力转写.txt', '听力原文.txt']

DUMP_OUT = ['题目.txt', '作业截图.png', '答案模板.json']
FILL_OUT = ['quiz_filled.png']

PORT = int(os.environ.get('CHX_PORT') or 9222)
START_URL = os.environ.get('CHX_START_URL') or 'https://mooc1.chaoxing.com/visit/courses'

BROWSERS = [
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
]


# ────────────────────────── 小工具 ──────────────────────────

def emit(payload):
    """输出机器可读结果行（AI 靠这行拿结构化结果）。"""
    print('CHX_RESULT ' + json.dumps(payload, ensure_ascii=False), flush=True)


def info(msg):
    print('[chx] ' + msg, flush=True)


def mtime(path):
    return os.path.getmtime(path) if os.path.exists(path) else 0


def fileinfo(name):
    p = os.path.join(HERE, name)
    if not os.path.exists(p):
        return None
    return {
        'size': os.path.getsize(p),
        'mtime': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(os.path.getmtime(p))),
    }


def find_node():
    """便携 node → WorkBuddy 托管 node → PATH。"""
    for p in glob.glob(os.path.join(ROOT, '*', 'node', 'node.exe')):
        return p
    for pat in ('~/.workbuddy-ai/binaries/node/versions/*/node.exe',
                '~/.workbuddy/binaries/node/versions/*/node.exe'):
        hits = sorted(glob.glob(os.path.expanduser(pat)))
        if hits:
            return hits[-1]
    return shutil.which('node')


def find_playwright():
    """playwright-core 的所在目录（本仓库里它装在 ..\\刷章节\\node_modules）。"""
    for d in (os.path.join(ROOT, '刷章节', 'node_modules'),
              os.path.join(HERE, 'node_modules'),
              os.path.join(ROOT, 'node_modules')):
        if os.path.isdir(os.path.join(d, 'playwright-core')):
            return d
    return None


def find_browser():
    env = os.environ.get('CHX_BROWSER')
    if env and os.path.exists(env):
        return env
    for p in BROWSERS:
        if os.path.exists(p):
            return p
    return None


def profile_dir():
    env = os.environ.get('CHX_PROFILE')
    if env:
        return env
    p = os.path.join(os.path.expanduser('~'), 'edge-quiz-profile')
    if os.path.isdir(p):
        return p
    return os.path.join(ROOT, 'edge-profile')


def cdp_open(port=None, timeout=0.5):
    """调试端口是否已开（开着说明「独立浏览器」在跑，脚本会复用它）。"""
    port = port or PORT
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=timeout):
            return True
    except OSError:
        return False


# ────────────────────────── 浏览器自启 ──────────────────────────

def _profile_processes():
    """列出正在使用本项目登录态目录的浏览器进程（没有就返回 []）。"""
    key = os.path.basename(profile_dir().rstrip('\\/')).lower()
    ps = (
        "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' or Name='chrome.exe'\" | "
        "Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('%s') } | "
        "ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }" % key
    )
    try:
        out = subprocess.run(['powershell', '-NoProfile', '-Command', ps],
                             capture_output=True, text=True, timeout=25).stdout
    except Exception:
        return []
    res = []
    for line in out.splitlines():
        line = line.strip()
        if '|' in line:
            pid, cmd = line.split('|', 1)
            if pid.isdigit():
                res.append((int(pid), cmd))
    return res


def kill_profile_browsers():
    """只杀「用本项目登录态目录」的浏览器，绝不动用户日常浏览器。"""
    procs = _profile_processes()
    if not procs:
        info('没有占用该登录态目录的浏览器进程')
        return 0
    for pid, _ in procs:
        try:
            subprocess.run(['taskkill', '/PID', str(pid), '/F'],
                           capture_output=True, timeout=15)
        except Exception:
            pass
    info('已关闭 %d 个占用该登录态目录的浏览器进程' % len(procs))
    time.sleep(1.5)
    return len(procs)


def launch_browser(port, url, profile):
    """以「脱离进程」方式启动独立浏览器（脚本退出不带走窗口）。"""
    exe = find_browser()
    if not exe:
        raise RuntimeError('没找到 Edge/Chrome，可用环境变量 CHX_BROWSER 指定路径')
    os.makedirs(profile, exist_ok=True)
    args = [
        exe,
        '--remote-debugging-port=%d' % port,
        '--user-data-dir=%s' % profile,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1400,900',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        url,
    ]
    DETACHED_PROCESS = 0x00000008
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    subprocess.Popen(
        args,
        close_fds=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
    )
    info('已启动独立浏览器（与脚本进程脱离，脚本结束窗口仍在）')
    return exe


def ensure_browser(url=None, restart=False, wait=25):
    """确保「带调试端口的独立浏览器」就绪：已开就复用，没开就自己拉起来。

    返回 'reused' / 'launched' / 'timeout'
    """
    url = url or START_URL

    if restart:
        kill_profile_browsers()

    if cdp_open():
        info('调试端口 %d 已开 → 复用现有浏览器窗口' % PORT)
        return 'reused'

    busy = _profile_processes()
    if busy:
        info('⚠ 已有 %d 个浏览器进程占用登录态目录，但没开调试端口' % len(busy))
        info('   此时新窗口会并入旧进程、端口依旧不开 → 建议：python chx.py browser --restart')

    info('调试端口 %d 未开 → 自动拉起独立浏览器…' % PORT)
    launch_browser(PORT, url, profile_dir())

    t0 = time.time()
    while time.time() - t0 < wait:
        if cdp_open():
            info('浏览器已就绪（%.1fs），窗口中已打开课程页 → 你点进作业即可' % (time.time() - t0))
            return 'launched'
        time.sleep(0.5)

    info('⚠ %d 秒内没等到调试端口，常见原因：' % wait)
    info('   1) 登录态目录被另一个窗口占用（那窗口没开调试端口）')
    info('   2) 浏览器启动被安全软件拦截')
    info('   处理：python chx.py browser --restart')
    return 'timeout'


def archive_root():
    d = os.environ.get('CHX_ARCHIVE_ROOT')
    if d:
        return d
    # 默认：学习通作业助手 的上一级目录（例：D://你的目录）下的 课程作业
    return os.path.abspath(os.path.join(HERE, '..', '..', '课程作业'))


def node_env(ai_mode=True):
    """给 node 子进程准备环境：NODE_PATH 指到 playwright-core，AI 模式关闭阻塞等待。"""
    env = dict(os.environ)
    pw = find_playwright()
    if pw:
        old = env.get('NODE_PATH')
        env['NODE_PATH'] = pw + (os.pathsep + old if old else '')
    env.setdefault('PYTHONIOENCODING', 'utf-8')
    # 本机默认带系统代理，本地调试端口必须绕过，否则 CDP 连接会被代理回 502
    no_proxy = env.get('NO_PROXY') or env.get('no_proxy') or ''
    for host in ('127.0.0.1', 'localhost'):
        if host not in no_proxy:
            no_proxy = (no_proxy + ',' + host) if no_proxy else host
    env['NO_PROXY'] = env['no_proxy'] = no_proxy
    if ai_mode:
        # 关键：跑完立刻退出、不关浏览器窗口，避免 AI 的调用被 sleep 卡住
        env.setdefault('CHX_AFTER', 'exit')
        env.setdefault('CHX_KEEP_OPEN_SECONDS', '0')
    return env


def run_stream(cmd, env=None, cwd=HERE):
    """流式执行子进程并实时回显（这样人工也能看到进度）。"""
    print('$ ' + ' '.join('"%s"' % c if ' ' in str(c) else str(c) for c in cmd), flush=True)
    t0 = time.time()
    e = dict(os.environ)
    # 🛠 v7.2（2026-10-22）：子进程（archive_homework.py 等）在 GBK 控制台输出中文，
    #    这里按 utf-8 解码 → 全乱码 → 「归档完成 -> 路径」正则永远匹配不上 →
    #    归档明明成功却报 ok:false（实测踩过：returncode=0 但 dest=null）。
    #    统一强制子进程用 utf-8 输出。
    e['PYTHONIOENCODING'] = 'utf-8'
    if env:
        e.update(env)
    proc = subprocess.Popen(cmd, cwd=cwd, env=e,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    lines = []
    for raw in proc.stdout:
        line = raw.decode('utf-8', 'replace').rstrip('\r\n')
        lines.append(line)
        print(line, flush=True)
    proc.wait()
    return proc.returncode, '\n'.join(lines), round(time.time() - t0, 1)


# ────────────────────────── 子命令 ──────────────────────────

def cmd_doctor(argv):
    node = find_node()
    pw = find_playwright()
    br = find_browser()
    cdp = cdp_open()
    root = archive_root()

    print('环境自检')
    print('  node            : %s' % (node or '× 未找到'))
    print('  python          : %s' % sys.executable)
    print('  playwright-core : %s' % (pw or '× 未找到'))
    print('  浏览器          : %s' % (br or '× 未找到'))
    print('  调试端口        : %d %s' % (PORT, '已开（脚本会复用该窗口）' if cdp else '未开（dump/fill 会自动拉起）'))
    print('  登录态目录      : %s' % profile_dir())
    print('  工作区          : %s' % HERE)
    print('  归档根目录      : %s' % root)
    print('  answers.json    : %s' % ('已就绪' if os.path.exists(os.path.join(HERE, 'answers.json')) else '× 未就绪'))
    print('  archive_homework: %s' % ('已就绪' if os.path.exists(ARCHIVE_PY) else '× 未找到'))

    ok = all([node, pw, br, os.path.exists(ARCHIVE_PY)])
    emit({'action': 'doctor', 'ok': bool(ok), 'node': node, 'python': sys.executable,
          'playwright_core': pw, 'browser': br, 'port': PORT, 'cdp_9222': cdp,
          'profile': profile_dir(), 'workspace': HERE, 'archive_root': root})
    return 0 if ok else 1


def cmd_status(argv):
    files = {name: fileinfo(name) for name in DUMP_OUT + ['answers.json'] + FILL_OUT}
    root = archive_root()
    courses = []
    if os.path.isdir(root):
        for d in sorted(os.listdir(root)):
            full = os.path.join(root, d)
            if os.path.isdir(full):
                subs = sorted(x for x in os.listdir(full) if os.path.isdir(os.path.join(full, x)))
                courses.append({'course': d, 'homeworks': subs})

    payload = {
        'action': 'status', 'ok': True,
        'workspace': HERE, 'archive_root': root,
        'browser_ready': cdp_open(),
        'files': files,
        'courses': courses,
        'next_step': _next_step(files),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    emit(payload)
    return 0


def _next_step(files):
    if not files.get('题目.txt'):
        return '还没有题目：先运行 chx.py dump'
    if not files.get('answers.json'):
        return '题目已导出但缺 answers.json：把 题目.txt / 作业截图.png 交给 AI 解题，生成 answers.json'
    if not files.get('quiz_filled.png'):
        return '答案已就绪但还没填答：运行 chx.py fill'
    if mtime(os.path.join(HERE, 'quiz_filled.png')) < mtime(os.path.join(HERE, 'answers.json')):
        return 'answers.json 比截图新，可能改过答案：重跑 chx.py fill'
    return '已填答：核对浏览器里的答案 → 手动提交 → 运行 chx.py archive "课程名"'


def cmd_browser(argv):
    restart = ('--restart' in argv) or ('-r' in argv)
    url = None
    for i, a in enumerate(argv):
        if a == '--url' and i + 1 < len(argv):
            url = argv[i + 1]
        elif a.startswith('--url='):
            url = a.split('=', 1)[1]

    state = ensure_browser(url=url, restart=restart)
    ok = state in ('reused', 'launched')
    emit({'action': 'browser', 'ok': ok, 'state': state, 'port': PORT,
          'profile': profile_dir(), 'url': url or START_URL})
    return 0 if ok else 1


def cmd_dump(argv):
    node = find_node()
    if not node:
        emit({'action': 'dump', 'ok': False, 'error': '未找到 node.exe，请先运行 chx.py doctor'})
        return 2
    if not os.path.exists(DUMP_JS):
        emit({'action': 'dump', 'ok': False, 'error': '缺少 chaoxing_dump.js'})
        return 2

    # 浏览器没开就自己拉起来（不再要求用户提前开窗口）
    state = ensure_browser()
    if state == 'timeout':
        emit({'action': 'dump', 'ok': False, 'error': '浏览器未就绪（调试端口未开）',
              'hint': 'python chx.py browser --restart 后重试'})
        return 3

    t0 = time.time()
    rc, out, secs = run_stream([node, DUMP_JS], env=node_env())

    fresh = {name: (mtime(os.path.join(HERE, name)) >= t0 - 1) for name in DUMP_OUT}
    ok = rc == 0 and fresh.get('题目.txt')
    payload = {
        'action': 'dump', 'ok': bool(ok), 'returncode': rc, 'seconds': secs,
        'browser': state,
        'files': {name: fileinfo(name) for name in DUMP_OUT},
        'fresh': fresh,
    }
    if not ok:
        payload['hint'] = '常见原因：浏览器里没有打开作业作答页（URL 含 dowork）；打开后重跑。'
    emit(payload)
    return 0 if ok else (rc or 1)


LISTEN_JS = os.path.join(HERE, 'chaoxing_listen.js')


def cmd_listen(argv):
    """提取听力题音频 → 听力题N.mp3 + 听力工作单.json（转写后并入 blank 数组）。"""
    node = find_node()
    if not node:
        emit({'action': 'listen', 'ok': False, 'error': '未找到 node.exe'})
        return 2
    if not os.path.exists(LISTEN_JS):
        emit({'action': 'listen', 'ok': False, 'error': '缺少 chaoxing_listen.js'})
        return 2
    state = ensure_browser()
    if state == 'timeout':
        emit({'action': 'listen', 'ok': False, 'error': '浏览器未就绪', 'hint': 'python chx.py browser --restart'})
        return 3
    t0 = time.time()
    rc, out, secs = run_stream([node, LISTEN_JS], env=node_env())
    work = os.path.join(HERE, '听力工作单.json')
    mps = sorted(glob.glob(os.path.join(HERE, '听力题*.mp3')))
    ok = rc == 0 and (mps or os.path.exists(work))
    emit({'action': 'listen', 'ok': bool(ok), 'returncode': rc, 'seconds': secs,
          'browser': state,
          'audio_files': [os.path.basename(m) for m in mps],
          'worksheet': os.path.basename(work) if os.path.exists(work) else None,
          'hint': None if ok else '没抓到音频：先在浏览器里点一下音频播放键让 iframe 加载，再重跑'})
    return 0 if ok else (rc or 1)


def _count_mismatches(parsed):
    """answers.json 与 答案模板.json 的题型数量对齐检查，防止题号错位。"""
    tmpl_path = os.path.join(HERE, '答案模板.json')
    if not os.path.exists(tmpl_path):
        return None
    try:
        with open(tmpl_path, encoding='utf-8') as f:
            tmpl = json.load(f)
    except Exception:
        return None
    issues = []
    for k in ('single', 'judge', 'blank', 'essay'):
        want = len(tmpl.get(k) or [])
        got = len(parsed.get(k) or [])
        if want != got:
            issues.append('%s：题目 %d 个 / 给了 %d 个' % (k, want, got))
    return issues


def cmd_fill(argv):
    ans = os.path.join(HERE, 'answers.json')
    if not os.path.exists(ans):
        print('[ERROR] 缺少 answers.json —— 先让 AI 根据 题目.txt / 作业截图.png 生成答案文件。')
        emit({'action': 'fill', 'ok': False, 'error': 'answers.json 不存在'})
        return 2
    try:
        with open(ans, encoding='utf-8') as f:
            parsed = json.load(f)
    except Exception as e:
        print('[ERROR] answers.json 解析失败：%s' % e)
        emit({'action': 'fill', 'ok': False, 'error': 'answers.json 解析失败: %s' % e})
        return 2

    # 路由：最近一次导出是考试模式 → 走通用考试填答（在 ..\考试\）
    if exam_mode_active():
        info('检测到考试模式（考试单元.json 比 题目.txt 新）→ 走考试填答脚本')
        return run_exam_fill()

    issues = _count_mismatches(parsed)
    if issues and os.environ.get('CHX_ALLOW_MISMATCH') != '1':
        print('[ERROR] 答案数量与题目模板不一致，已阻止填答（防题号错位）：')
        for it in issues:
            print('        - ' + it)
        print('        确认无误要继续，可设 CHX_ALLOW_MISMATCH=1')
        emit({'action': 'fill', 'ok': False, 'error': '答案数量与模板不一致', 'mismatches': issues})
        return 2

    node = find_node()
    if not node:
        emit({'action': 'fill', 'ok': False, 'error': '未找到 node.exe'})
        return 2

    counts = {k: len(v) for k, v in parsed.items() if isinstance(v, list)}
    info('answers.json 已载入：' + json.dumps(counts, ensure_ascii=False))

    state = ensure_browser()
    if state == 'timeout':
        emit({'action': 'fill', 'ok': False, 'error': '浏览器未就绪（调试端口未开）',
              'hint': 'python chx.py browser --restart 后重试'})
        return 3

    t0 = time.time()
    rc, out, secs = run_stream([node, FILL_JS], env=node_env())

    m = re.search(r'结果:\s*(.+)', out)
    payload = {
        'action': 'fill', 'ok': rc == 0, 'returncode': rc, 'seconds': secs,
        'browser': state,
        'summary': m.group(1).strip() if m else None,
        'files': {name: fileinfo(name) for name in FILL_OUT},
        'fresh': mtime(os.path.join(HERE, 'quiz_filled.png')) >= t0 - 1,
    }
    if rc != 0:
        payload['hint'] = 'rc=2 作答页超时；rc=3 部分题目未填成功（看 errors 字段）。'
    emit(payload)
    return 0 if rc == 0 else rc


def exam_mode_active():
    """最近一次导出是不是考试模式（考试单元.json 有 units 且比 题目.txt 新或同时生成）。"""
    if not os.path.exists(EXAM_UNITS):
        return False
    # v6（2026-10-22）：必须真有 units —— 否则「抓 0 题」的空产物也会被当成有效考试导出
    try:
        with open(EXAM_UNITS, encoding='utf-8') as f:
            if not (json.load(f).get('units') or []):
                return False
    except Exception:
        return False
    paper = os.path.join(HERE, '题目.txt')
    if not os.path.exists(paper):
        return True
    try:
        return mtime(EXAM_UNITS) >= mtime(paper) - 3
    except Exception:
        return False


def run_exam_fill():
    """调用 ..\\考试\\chaoxing_exam_fill.js（通用考试填答）。"""
    node = find_node()
    if not node:
        emit({'action': 'exam-fill', 'ok': False, 'error': '未找到 node.exe'})
        return 2
    if not os.path.exists(EXAM_FILL_JS):
        emit({'action': 'exam-fill', 'ok': False,
              'error': '缺少 考试\\chaoxing_exam_fill.js'})
        return 2
    state = ensure_browser()
    if state == 'timeout':
        emit({'action': 'exam-fill', 'ok': False, 'error': '浏览器未就绪',
              'hint': 'python chx.py browser --restart'})
        return 3
    env = node_env()
    env['CHX_WORKDIR'] = HERE          # 答案/题目都在 写作业\，脚本本身住在 考试\
    t0 = time.time()
    rc, out, secs = run_stream([node, EXAM_FILL_JS], env=env)
    m = re.search(r'成功\s*(\d+)\s*/\s*失败\s*(\d+)', out)
    payload = {
        'action': 'exam-fill', 'ok': rc == 0, 'returncode': rc, 'seconds': secs,
        'browser': state,
        'filled': int(m.group(1)) if m else None,
        'failed': int(m.group(2)) if m else None,
        'files': {name: fileinfo(name) for name in ('考试填答结果.json',)},
    }
    if rc != 0:
        payload['hint'] = '个别题型可能未识别（如连线/排序），看 考试填答结果.json 的 errs'
    emit(payload)
    return 0 if rc == 0 else rc


def read_transcript():
    """找听力转写稿：先看 --transcript 指定，再看固定候选名。"""
    for name in TRANSCRIPT_FILES:
        p = os.path.join(HERE, name)
        if os.path.exists(p):
            try:
                with open(p, encoding='utf-8') as f:
                    txt = f.read().strip()
                if txt:
                    return name, txt
            except Exception:
                pass
    return None, ''


SNAP_FILES = ['题目.txt', '答案模板.json', 'answers.json', '解析.json']


def snapshot_files():
    """导出前备份上次的题目/答案，防止进错页面把它们覆盖掉。"""
    saved = {}
    for n in SNAP_FILES:
        p = os.path.join(HERE, n)
        if os.path.exists(p):
            try:
                with open(p, 'rb') as f:
                    saved[n] = f.read()
            except Exception:
                pass
    return saved


def restore_files(saved):
    for n, b in saved.items():
        try:
            with open(os.path.join(HERE, n), 'wb') as f:
                f.write(b)
        except Exception:
            pass


def cmd_exam(argv):
    """考试一条龙：逐题导出 → AI 答题 → 逐题填答 → 归档（任何课程通用）。"""
    course_opt = None
    seq_opt = None
    skip_ai = '--skip-ai' in argv
    skip_dump = '--skip-dump' in argv   # v6（2026-10-22）：复用现有导出文件，不重新抓题
    no_fill = '--no-fill' in argv
    no_archive = '--no-archive' in argv
    transcript_opt = None
    for i, a in enumerate(argv):
        if a == '--course' and i + 1 < len(argv):
            course_opt = argv[i + 1]
        elif a.startswith('--course='):
            course_opt = a.split('=', 1)[1]
        elif a == '--seq' and i + 1 < len(argv):
            seq_opt = argv[i + 1]
        elif a.startswith('--seq='):
            seq_opt = a.split('=', 1)[1]
        elif a == '--transcript' and i + 1 < len(argv):
            transcript_opt = argv[i + 1]

    steps = []
    t_all = time.time()

    # ① 导出（dump 内部自动识别考试页 → 逐题遍历）
    if skip_dump:
        info('【1/5】跳过导出（--skip-dump）→ 复用现有 题目.txt / 考试单元.json')
        if not exam_mode_active():
            info('✗ 现有导出文件无效（考试单元.json 没有 units）。去掉 --skip-dump 重跑。')
            emit({'action': 'exam', 'ok': False, 'stage': 'dump',
                  'hint': '--skip-dump 但现有导出为空'})
            return 4
    else:
        info('【1/5】导出考试题目（逐题遍历）…')
        snap = snapshot_files()          # 先备份：进错页面不至于把上次题目/答案冲掉
        rc = cmd_dump([])
        if rc != 0:
            info('✗ 导出失败，终止')
            restore_files(snap)
            return rc
        if not exam_mode_active():
            info('✗ 当前页面不像考试作答页（没生成 考试单元.json）。')
            restore_files(snap)
            info('  （已恢复导出前的 题目.txt / 答案模板.json / answers.json）')
            info('  请先在浏览器里进入考试（输入验证码后），再重跑：python chx.py exam')
            emit({'action': 'exam', 'ok': False, 'stage': 'dump',
                  'hint': '需要停在考试作答页（exam-ans/reVersionTestStartNew）'})
            return 4
    try:
        with open(EXAM_UNITS, encoding='utf-8') as f:
            meta_units = json.load(f)
        n_units = len(meta_units.get('units') or [])
        has_audio = any((u.get('audioOids') or []) for u in (meta_units.get('units') or []))
        if meta_units.get('partial'):
            info('⚠ 本次导出是残卷：抓到 %d 题 / 答题卡 %s 题（抓取中途页面失效）'
                 % (n_units, meta_units.get('cardCount', '?')))
            info('  答题会照常进行，但交卷前请对照答题卡确认没有漏题')
        info('考试单元：%d 个%s' % (n_units, '（含听力音频）' if has_audio else ''))
    except Exception:
        n_units, has_audio = 0, False
    steps.append('dump')

    # ② 课程名
    meta = {}
    if os.path.exists(META_JSON):
        try:
            with open(META_JSON, encoding='utf-8') as f:
                meta = json.load(f)
        except Exception:
            meta = {}
    course, _src = resolve_course(meta, course_opt, 'exam')
    if not course:
        return 4
    info('课程判定：%s' % course)
    steps.append('course=' + course)

    # ③ AI 答题
    ans_path = os.path.join(HERE, 'answers.json')
    if not skip_ai:
        cfg = load_llm_config()
        if not cfg.get('api_key'):
            info('✗ 没有配置 AI key（llm_config.json 里 api_key 为空）')
            emit({'action': 'exam', 'ok': False, 'stage': 'llm', 'hint': '配置 llm_config.json'})
            return 5
        with open(os.path.join(HERE, '答案模板.json'), encoding='utf-8') as f:
            tmpl = json.load(f)
        with open(os.path.join(HERE, '题目.txt'), encoding='utf-8') as f:
            paper = f.read()
        if not paper.strip():
            info('✗ 题目.txt 是空的')
            return 6

        prompt = build_prompt(paper, tmpl)
        tname, ttxt = read_transcript()
        if transcript_opt:
            tp = transcript_opt if os.path.isabs(transcript_opt) else os.path.join(HERE, transcript_opt)
            if os.path.exists(tp):
                with open(tp, encoding='utf-8') as f:
                    ttxt, tname = f.read().strip(), os.path.basename(tp)
        if ttxt:
            prompt += ('\n\n【听力原文】以下是听力题的转写稿，听力题必须依据它作答：\n' + ttxt)
            info('已附加听力原文：%s' % tname)
        elif has_audio:
            info('⚠ 检测到听力题但没有转写稿 → 听力答案只能靠 AI 猜')
            info('  建议：把音频文件发给我转写，存成 考试听力转写.txt 后重跑 --skip-ai 之外的流程')

        info('【2/5】AI 答题中（%s / %s）…' % (' → '.join(model_chain(cfg)), cfg['base_url']))
        try:
            raw = ask_llm(prompt, cfg)
        except Exception as e:
            info('✗ AI 调用失败：%s' % e)
            emit({'action': 'exam', 'ok': False, 'stage': 'llm', 'error': str(e)})
            return 7
        try:
            answers = parse_json_block(raw)
        except Exception as e:
            with open(os.path.join(HERE, 'ai_raw.txt'), 'w', encoding='utf-8') as f:
                f.write(raw)
            info('✗ 模型回复不是合法 JSON（原文存到 ai_raw.txt）：%s' % e)
            emit({'action': 'exam', 'ok': False, 'stage': 'llm-parse', 'error': str(e)})
            return 8
        explain = answers.pop('explain', None)
        with open(ans_path, 'w', encoding='utf-8') as f:
            json.dump(answers, f, ensure_ascii=False, indent=2)
        info('答案已生成：' + json.dumps({k: len(v) for k, v in answers.items()
                                         if isinstance(v, list)}, ensure_ascii=False))
        if not isinstance(explain, dict) or not explain:
            info('模型没带解析 → 再调一次专门要解析…')
            try:
                explain = parse_json_block(ask_llm(build_explain_prompt(paper, answers), cfg))
            except Exception as e:
                info('⚠ 解析生成失败（不影响答题）：%s' % str(e)[:80])
                explain = None
        if isinstance(explain, dict) and explain:
            with open(os.path.join(HERE, '解析.json'), 'w', encoding='utf-8') as f:
                json.dump(explain, f, ensure_ascii=False, indent=2)
            info('解析已生成：%d 题 → 解析.json' % len(explain))
        steps.append('ai')
    else:
        info('【2/5】跳过 AI，沿用现有 answers.json')
        if not os.path.exists(ans_path):
            info('✗ --skip-ai 但 answers.json 不存在')
            return 5

    # ④ 逐题填答（通用：单选/多选/判断/填空/简答）
    if not no_fill:
        info('【3/5】逐题填答（考试模式）…')
        rc = run_exam_fill()
        if rc != 0:
            info('✗ 填答未完全成功（rc=%s），详情看 考试填答结果.json' % rc)
            return rc
        steps.append('fill')
    else:
        info('【3/5】跳过填答')

    # ⑤ 归档（题目+答案+解析 → 课程作业\\课程名\\第N次作业）
    dest = None
    if not no_archive:
        info('【4/5】归档…')
        arc_args = [course] + ([seq_opt] if seq_opt else []) + ['--yes']
        rc = cmd_archive(arc_args)
        if rc != 0:
            info('⚠ 归档失败（rc=%s），但题目/答案都在工作区，可手动归档' % rc)
        else:
            steps.append('archive')
            dest = archive_root() + os.sep + course
    else:
        info('【4/5】跳过归档')

    secs = round(time.time() - t_all, 1)
    info('【5/5】完成，用时 %.1fs' % secs)
    if dest:
        info('归档位置：%s' % dest)
    info('👉 最后一步仍需要你：核对答案 → 自己点「提交考试」')
    emit({'action': 'exam', 'ok': True, 'course': course, 'units': n_units,
          'seq': seq_opt or '自动递增', 'steps': steps, 'dest': dest, 'seconds': secs,
          'next': '人工核对并提交'})
    return 0


def cmd_archive(argv):
    if not argv:
        print('[ERROR] 用法：python chx.py archive "课程名" ["第N次作业"]')
        emit({'action': 'archive', 'ok': False, 'error': '缺少课程名参数'})
        return 2
    if not os.path.exists(ARCHIVE_PY):
        emit({'action': 'archive', 'ok': False, 'error': '缺少 archive_homework.py'})
        return 2

    rc, out, secs = run_stream([sys.executable, ARCHIVE_PY] + list(argv))
    m = re.search(r'归档完成\s*->\s*(.+)', out)
    dest = m.group(1).strip() if m else None
    payload = {'action': 'archive', 'ok': rc == 0 and bool(dest), 'returncode': rc,
               'seconds': secs, 'dest': dest}
    if not dest:
        payload['hint'] = ('rc=0 但没匹配到「归档完成」输出：多半是子进程输出编码问题（已强制 utf-8，重跑应恢复）；'
                           'rc=1 才是「题目.txt 不存在」——先运行 chx.py dump。')
    emit(payload)
    return 0 if payload['ok'] else (rc or 1)


# ────────────────────────── 全自动流水线 ──────────────────────────

LLM_CONFIG = os.path.join(HERE, 'llm_config.json')
META_JSON = os.path.join(HERE, '作业信息.json')


def load_llm_config():
    """读取 llm_config.json（OpenAI 兼容接口），环境变量可覆盖。"""
    # 默认走智谱 glm-5.3-flash（同代最强性价比，资源包额度大）；兜底 glm-4.5-flash 免费
    cfg = {'base_url': 'https://open.bigmodel.cn/api/paas/v4',
           'models': ['glm-5.3-flash', 'glm-5.3-flashx', 'glm-4.5-flash'],
           'model': 'glm-5.3-flash',
           'api_key': '', 'temperature': 0.2, 'timeout': 180}
    if os.path.exists(LLM_CONFIG):
        try:
            with open(LLM_CONFIG, encoding='utf-8') as f:
                for k, v in json.load(f).items():
                    if v not in (None, ''):
                        cfg[k] = v
        except Exception as e:
            info('llm_config.json 解析失败：%s（用默认值）' % e)
    for env, key in (('CHX_LLM_KEY', 'api_key'), ('CHX_LLM_BASE', 'base_url'),
                     ('CHX_LLM_MODEL', 'model')):
        if os.environ.get(env):
            cfg[key] = os.environ[env]
            if key == 'model':                       # 环境变量指定模型 → 只试它
                cfg['models'] = [os.environ[env]]
    if not cfg.get('models'):
        cfg['models'] = [cfg.get('model')]
    return cfg


def save_llm_config(patch):
    """把 patch 合并进 llm_config.json（不存在则先按模板建）。"""
    base = {}
    src = LLM_CONFIG if os.path.exists(LLM_CONFIG) else None
    if src:
        try:
            with open(src, encoding='utf-8') as f:
                base = json.load(f)
        except Exception:
            base = {}
    if not base:
        ex = os.path.join(HERE, 'llm_config.example.json')
        if os.path.exists(ex):
            try:
                with open(ex, encoding='utf-8') as f:
                    base = json.load(f)
            except Exception:
                base = {}
    base.update(patch)
    with open(LLM_CONFIG, 'w', encoding='utf-8') as f:
        json.dump(base, f, ensure_ascii=False, indent=2)
    return LLM_CONFIG


def cmd_llm(argv):
    """自检 AI 接口：读配置 → 发一句话 → 报告能不能用。"""
    # --key XXX 直接写入配置，省得手改 JSON
    for i, a in enumerate(argv):
        if a == '--key' and i + 1 < len(argv):
            p = save_llm_config({'api_key': argv[i + 1].strip()})
            info('✓ api_key 已写入 %s' % p)
        elif a.startswith('--key='):
            p = save_llm_config({'api_key': a.split('=', 1)[1].strip()})
            info('✓ api_key 已写入 %s' % p)

    cfg = load_llm_config()
    info('base_url : %s' % cfg['base_url'])
    info('尝试模型 : %s' % ' → '.join(model_chain(cfg)))
    if not cfg.get('api_key'):
        info('✗ api_key 为空')
        info('  最快方式：双击「一键-配置AI.bat」，把 key 粘进去（会自动写入并测试）')
        info('  或手动：记事本打开 ' + LLM_CONFIG + '，把 key 填到 "api_key": "" 的引号里')
        info('  免费领 key：https://open.bigmodel.cn/usercenter/apikeys')
        emit({'action': 'llm', 'ok': False, 'stage': 'config', 'hint': 'api_key 为空'})
        return 5
    info('api_key  : %s…%s（%d 位）'
         % (cfg['api_key'][:6], cfg['api_key'][-4:], len(cfg['api_key'])))
    info('正在联调…')
    t0 = time.time()
    try:
        reply = ask_llm('请只回一个 JSON：{"ok":true}', cfg)
    except Exception as e:
        info('✗ 调用失败：%s' % e)
        info('  常见原因：key 复制不全 / 没实名认证 / 模型名不对 / 网络代理拦截')
        emit({'action': 'llm', 'ok': False, 'stage': 'call', 'error': str(e)})
        return 7
    info('✓ 可用，用时 %.1fs' % (time.time() - t0))
    info('模型回复：%s' % reply.strip()[:120])
    emit({'action': 'llm', 'ok': True, 'base_url': cfg['base_url'],
          'models': model_chain(cfg), 'reply': reply.strip()[:200]})
    return 0


def _call_once(prompt, cfg, model, timeout=None):
    """单模型单次调用（OpenAI 兼容格式）。"""
    import urllib.error
    import urllib.request

    url = cfg['base_url'].rstrip('/') + '/chat/completions'
    body = json.dumps({
        'model': model,
        'temperature': float(cfg.get('temperature', 0.2)),
        'messages': [
            {'role': 'system', 'content': '你是严谨的课程作业答题助手，只输出 JSON，不解释。'},
            {'role': 'user', 'content': prompt},
        ],
    }).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='POST', headers={
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg['api_key'],
    })
    try:
        with urllib.request.urlopen(req, timeout=int(timeout or cfg.get('timeout', 180))) as r:
            data = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:300]
        raise RuntimeError('模型接口返回 %s：%s' % (e.code, detail))
    return data['choices'][0]['message']['content']


def model_chain(cfg):
    """要依次尝试的模型列表：models 数组优先，否则只用 model。"""
    ms = cfg.get('models')
    if isinstance(ms, list) and ms:
        return [str(m) for m in ms if str(m).strip()]
    return [cfg.get('model') or 'deepseek-chat']


def ask_llm(prompt, cfg):
    """调用 OpenAI 兼容接口 —— DeepSeek / 通义 / 智谱 / Kimi 都是这个格式。

    按 models 列表依次尝试：某个模型 429/不可用/超时 → 自动换下一个。
    """
    errs = []
    for m in model_chain(cfg):
        try:
            out = _call_once(prompt, cfg, m)
            if m != model_chain(cfg)[0]:
                info('（已自动降级到模型 %s）' % m)
            return out
        except Exception as e:
            errs.append('%s → %s' % (m, str(e).split('\n')[0][:160]))
            if m != model_chain(cfg)[-1]:
                info('⚠ 模型 %s 不可用，换下一个…' % m)
    raise RuntimeError('所有模型都失败：' + ' | '.join(errs))


def parse_json_block(text):
    """从模型回复里抠出 JSON（容忍 ```json 包裹和前后废话）。"""
    t = (text or '').strip()
    t = re.sub(r'^```[a-zA-Z]*\s*', '', t)
    t = re.sub(r'```\s*$', '', t).strip()
    i, j = t.find('{'), t.rfind('}')
    if i < 0 or j <= i:
        raise ValueError('回复里没有 JSON：' + t[:120])
    return json.loads(t[i:j + 1])


def guess_course(candidates):
    """把页面候选文字与已有课程文件夹做**相似度**匹配（容忍 A/B 班、括号学年等差异）。"""
    from difflib import SequenceMatcher

    def norm(s):
        s = re.sub(r'[（(].*?[）)]', '', str(s or ''))       # 去括号里的班级/学年
        return re.sub(r'\s+', '', s).strip()

    root = archive_root()
    if not (candidates and os.path.isdir(root)):
        return None
    best, best_score = None, 0.0
    for d in os.listdir(root):
        if not os.path.isdir(os.path.join(root, d)):
            continue
        core = norm(d)
        if not core:
            continue
        for c in candidates:
            cc = norm(c)
            if not cc:
                continue
            score = SequenceMatcher(None, core, cc).ratio()
            if core in cc or cc in core:
                score = max(score, 0.95)
            if score > best_score:
                best, best_score = d, score
    return best if best_score >= 0.55 else None


# ── v7（2026-10-22）：courseId → 课程名 缓存 ──────────────────────────────
# 背景：dowork / 考试页的 DOM 里常常根本没有课程名（标题只有"作业作答"/"考试"），
# 相似度匹配无从谈起。但 URL 里一定带 courseId —— 它才是课程唯一标识。
# 第一次用户指定课程名后按 courseId 记住，以后同课程的作业/考试全自动识别。
COURSE_MAP = os.path.join(HERE, '课程映射.json')


def load_course_map():
    if not os.path.exists(COURSE_MAP):
        return {}
    try:
        with open(COURSE_MAP, encoding='utf-8') as f:
            return json.load(f) or {}
    except Exception:
        return {}


def save_course_map(m):
    try:
        with open(COURSE_MAP, 'w', encoding='utf-8') as f:
            json.dump(m, f, ensure_ascii=False, indent=2)
    except Exception as e:
        info('⚠ 课程映射.json 写入失败：%s' % e)


def resolve_course(meta, course_opt, action):
    """课程名四级判定：--course 参数 → 页面候选相似度 → courseId 缓存 → 控制台提问。
    返回 (course, source)；认不出时 course 为 None。"""
    course = course_opt or guess_course(meta.get('candidates') or [])
    if course:
        return course, ('参数' if course_opt else '页面匹配')
    cmap = load_course_map()
    cid = str(meta.get('courseId') or '')
    if cid and cid in cmap:
        info('课程判定（courseId %s 缓存）：%s' % (cid, cmap[cid]))
        return cmap[cid], '缓存'
    if cid and sys.stdin.isatty():
        try:
            info('页面候选：%s' % ('、'.join((meta.get('candidates') or [])[:6]) or '无'))
            ans = input('【chx】没认出课程名，请输入（直接回车=终止）: ').strip()
        except (EOFError, KeyboardInterrupt):
            ans = ''
        if ans:
            cmap[cid] = ans
            if meta.get('classId'):
                cmap['%s:%s' % (cid, meta['classId'])] = ans
            save_course_map(cmap)
            info('已记住：courseId %s → %s（下次同课程自动识别）' % (cid, ans))
            return ans, '手动输入'
    if not course:
        info('✗ 没认出课程名。请加 --course "课程名" 重跑；页面候选：%s'
             % ('、'.join((meta.get('candidates') or [])[:6]) or '无'))
        emit({'action': action, 'ok': False, 'stage': 'course',
              'candidates': meta.get('candidates') or [],
              'hint': '加 --course "课程名" 指定'})
    return None, ''


def build_prompt(paper, tmpl):
    want = {k: len(tmpl.get(k) or []) for k in ('single', 'judge', 'blank', 'essay')}
    return (
        '下面是学习通的作业题目，请全部作答。只输出 JSON，不要任何解释。\n\n'
        '输出格式（数组长度必须严格等于括号里的数字）：\n'
        '{"single":[%d 项],"judge":[%d 项],"blank":[%d 项],"essay":[%d 项],'
        '"explain":{"题号":"解题思路"}}\n\n'
        '规则：\n'
        '- single 收单选题与多选题；**阅读理解/完形填空的子题也算单选题**，连同大题的普通单选一起，按题目编号顺序填入\n'
        '- 多选按字母顺序连写，如 "ABC"\n'
        '- judge 判断题用 "A"（正确）或 "B"（错误）\n'
        '- blank 填空题填语义答案，多个空用；分隔\n'
        '- essay 简答/计算题写完整作答文本\n'
        '- 题号顺序必须与题目一致，不得漏题\n'
        '- explain 里给每道题写 1~3 句解题思路（为什么选它/考点是什么/'
        '干扰项为什么错），供学生期末复习，键是题号的字符串\n\n'
        '题目如下：\n%s'
    ) % (want['single'], want['judge'], want['blank'], want['essay'], paper)


EXPLAIN_PROMPT = (
    '下面是作业题目与已确定的答案。请为每道题写解题思路，只输出 JSON：\n'
    '{"1":"思路…","2":"思路…"}（键为题号字符串，每题 1~3 句：考点、'
    '为什么选这个答案、干扰项为什么错。不要重新作答。）\n\n题目与答案：\n%s'
)


def build_explain_prompt(paper, ans):
    lines = []
    counters = {'single': 0, 'judge': 0, 'blank': 0, 'essay': 0}
    for it in parse_paper_for_explain(paper):
        key = {'单选题': 'single', '多选题': 'single', '判断题': 'judge',
               '填空题': 'blank', '听力题': 'blank', '简答题': 'essay',
               '计算题': 'essay'}.get(it['type'])
        got = ''
        if key:
            arr = ans.get(key) or []
            i = counters[key]
            if i < len(arr):
                got = str(arr[i])
            counters[key] = i + 1
        lines.append('%d. (%s) %s\n   答案：%s' % (it['num'], it['type'], it['text'], got or '(未答)'))
    return EXPLAIN_PROMPT % '\n'.join(lines)


def parse_paper_for_explain(txt):
    items = []
    cur = None
    for raw in txt.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        m = re.match(r'^\s*(\d+)\.\s*\(([^)]+)\)\s*(.*)$', line)
        if m:
            if cur:
                items.append(cur)
            cur = {'num': int(m.group(1)), 'type': m.group(2).strip(), 'text': m.group(3).strip()}
        elif cur is not None and line.startswith('   '):
            cur['text'] += ' ' + line.strip()
    if cur:
        items.append(cur)
    return items


def cmd_auto(argv):
    """一条命令跑完：导出 → AI 答题 → 填答 → 按课程归档。"""
    course_opt = None
    seq_opt = None
    skip_ai = '--skip-ai' in argv
    no_fill = '--no-fill' in argv
    no_archive = '--no-archive' in argv
    for i, a in enumerate(argv):
        if a == '--course' and i + 1 < len(argv):
            course_opt = argv[i + 1]
        elif a.startswith('--course='):
            course_opt = a.split('=', 1)[1]
        elif a == '--seq' and i + 1 < len(argv):
            seq_opt = argv[i + 1]
        elif a.startswith('--seq='):
            seq_opt = a.split('=', 1)[1]

    steps = []
    t_all = time.time()

    # ① 导出题目（内部会自动把浏览器拉起来）
    info('【1/5】导出题目…')
    rc = cmd_dump([])
    if rc != 0:
        info('✗ 导出失败，终止')
        return rc
    steps.append('dump')

    # ② 判定课程名
    meta = {}
    if os.path.exists(META_JSON):
        try:
            with open(META_JSON, encoding='utf-8') as f:
                meta = json.load(f)
        except Exception:
            meta = {}
    course, _src = resolve_course(meta, course_opt, 'auto')
    if not course:
        return 4
    info('课程判定：%s' % course)
    steps.append('course=' + course)

    # ③ 答案：AI 现做，或复用已有的 answers.json
    ans_path = os.path.join(HERE, 'answers.json')
    if not skip_ai:
        cfg = load_llm_config()
        if not cfg.get('api_key'):
            info('✗ 没有配置 AI key（llm_config.json 里 api_key 为空）')
            info('  两种选择：')
            info('    a) 填 api_key 后重跑：' + LLM_CONFIG)
            info('    b) 本次先跳过 AI：python chx.py auto --skip-ai（会直接用已有的 answers.json）')
            emit({'action': 'auto', 'ok': False, 'stage': 'llm',
                  'hint': '配置 llm_config.json 的 api_key，或加 --skip-ai'})
            return 5

        tpl_path = os.path.join(HERE, '答案模板.json')
        with open(tpl_path, encoding='utf-8') as f:
            tmpl = json.load(f)
        with open(os.path.join(HERE, '题目.txt'), encoding='utf-8') as f:
            paper = f.read()
        if not paper.strip():
            info('✗ 题目.txt 是空的')
            return 6

        info('【2/5】AI 答题中（%s / %s）…'
             % (' → '.join(model_chain(cfg)), cfg['base_url']))
        try:
            raw = ask_llm(build_prompt(paper, tmpl), cfg)
        except Exception as e:
            info('✗ AI 调用失败：%s' % e)
            emit({'action': 'auto', 'ok': False, 'stage': 'llm', 'error': str(e)})
            return 7
        try:
            answers = parse_json_block(raw)
        except Exception as e:
            with open(os.path.join(HERE, 'ai_raw.txt'), 'w', encoding='utf-8') as f:
                f.write(raw)
            info('✗ 模型回复不是合法 JSON（原文存到 ai_raw.txt）：%s' % e)
            emit({'action': 'auto', 'ok': False, 'stage': 'llm-parse', 'error': str(e)})
            return 8

        # 解析单独拆出来（answers.json 保持纯答案格式，fill 脚本零改动）
        explain = answers.pop('explain', None)
        with open(ans_path, 'w', encoding='utf-8') as f:
            json.dump(answers, f, ensure_ascii=False, indent=2)
        info('答案已生成：' + json.dumps({k: len(v) for k, v in answers.items()
                                         if isinstance(v, list)}, ensure_ascii=False))

        # 解析（期末复习用）：模型没给就补一枪
        if not isinstance(explain, dict) or not explain:
            info('模型没带解析 → 再调一次专门要解析…')
            try:
                raw2 = ask_llm(build_explain_prompt(paper, answers), cfg)
                explain = parse_json_block(raw2)
            except Exception as e:
                info('⚠ 解析生成失败（不影响答题）：%s' % str(e)[:80])
                explain = None
        if isinstance(explain, dict) and explain:
            with open(os.path.join(HERE, '解析.json'), 'w', encoding='utf-8') as f:
                json.dump(explain, f, ensure_ascii=False, indent=2)
            info('解析已生成：%d 题 → 解析.json' % len(explain))
        else:
            if os.path.exists(os.path.join(HERE, '解析.json')):
                os.remove(os.path.join(HERE, '解析.json'))
            info('⚠ 本次没有解题解析（答案本身不受影响）')
        steps.append('ai')
    else:
        info('【2/5】跳过 AI，沿用现有 answers.json')
        if not os.path.exists(ans_path):
            info('✗ --skip-ai 但 answers.json 不存在')
            return 5

    # ④ 填答
    if not no_fill:
        info('【3/5】自动填答…')
        rc = cmd_fill([])
        if rc != 0:
            info('✗ 填答失败（rc=%s），已停在当前状态，可人工检查' % rc)
            return rc
        steps.append('fill')
    else:
        info('【3/5】跳过填答')

    # ⑤ 归档（非交互，次数自动递增）
    dest = None
    if not no_archive:
        info('【4/5】归档…')
        arc_args = [course] + ([seq_opt] if seq_opt else []) + ['--yes']
        rc = cmd_archive(arc_args)
        if rc != 0:
            info('⚠ 归档失败（rc=%s），但题目/答案都在工作区，可手动归档' % rc)
        else:
            steps.append('archive')
            dest = archive_root() + os.sep + course
    else:
        info('【4/5】跳过归档')

    secs = round(time.time() - t_all, 1)
    info('【5/5】完成，用时 %.1fs' % secs)
    if dest:
        info('归档位置：%s' % dest)
    info('👉 最后一步仍需要你：在浏览器里核对答案 → 自己点「提交作业」')
    emit({'action': 'auto', 'ok': True, 'course': course, 'seq': seq_opt or '自动递增',
          'steps': steps, 'dest': dest, 'seconds': secs,
          'next': '人工核对浏览器中的答案并提交'})
    return 0


COMMANDS = {
    'doctor': cmd_doctor,
    'status': cmd_status,
    'browser': cmd_browser,
    'dump': cmd_dump,
    'listen': cmd_listen,
    'fill': cmd_fill,
    'exam': cmd_exam,
    'archive': cmd_archive,
    'llm': cmd_llm,
    'auto': cmd_auto,
}


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ('-h', '--help', 'help'):
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd not in COMMANDS:
        print('[ERROR] 未知子命令：%s' % cmd)
        print('可用：' + ' / '.join(COMMANDS))
        return 2
    return COMMANDS[cmd](rest)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('\n[中断]')
        sys.exit(130)
    except Exception as e:
        print('FATAL:', e)
        emit({'action': 'error', 'ok': False, 'error': str(e)})
        sys.exit(1)
