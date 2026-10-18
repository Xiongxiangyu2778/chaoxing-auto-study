# -*- coding: utf-8 -*-
"""学习通作业助手 · MCP 薄壳（零依赖，纯标准库）

把 chx.py 的六个动作暴露成 MCP 工具，让任何支持 MCP 的 AI 客户端都能直接调用。
**业务逻辑一律不在这里实现** —— 本文件只做「收参数 → 调 chx.py → 包结果」。

传输：stdio，换行分隔的 JSON-RPC（MCP 规范），日志一律写 stderr。
用法：由 AI 客户端拉起，不要手动运行。
"""

import base64
import io
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))          # ...\学习通作业助手\写作业
CHX = os.path.join(HERE, 'chx.py')
PYTHON = sys.executable

SERVER_NAME = 'chaoxing-homework'
SERVER_VERSION = '1.0.0'
DEFAULT_PROTOCOL = '2025-06-18'

# 单张截图超过这个体积就不塞进返回值，避免把上下文撑爆
MAX_IMAGE_BYTES = 3 * 1024 * 1024


def log(msg):
    print('[chaoxing-mcp] %s' % msg, file=sys.stderr, flush=True)


# ────────────────────── 调用 chx.py ──────────────────────

def run_chx(args, extra_env=None, timeout=300):
    """执行 chx.py，返回 (returncode, stdout, stderr, CHX_RESULT 解析结果)。"""
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONUTF8'] = '1'
    if extra_env:
        env.update({k: str(v) for k, v in extra_env.items() if v is not None})

    log('exec: chx.py %s' % ' '.join(args))
    try:
        p = subprocess.run([PYTHON, CHX] + list(args), cwd=HERE, env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, '', '执行超时（%s 秒）' % timeout, None

    out = p.stdout.decode('utf-8', 'replace')
    err = p.stderr.decode('utf-8', 'replace')

    result = None
    for line in out.splitlines():
        if line.startswith('CHX_RESULT '):
            try:
                result = json.loads(line[len('CHX_RESULT '):])
            except ValueError:
                pass
    return p.returncode, out, err, result


def tail(text, limit=2500):
    """子进程输出太长时只保留尾部（错误通常在最后）。"""
    text = (text or '').strip()
    if len(text) <= limit:
        return text
    return '...(前文省略)\n' + text[-limit:]


def text_content(s):
    return {'type': 'text', 'text': s}


def fail(s):
    return {'content': [text_content(s)], 'isError': True}


def done(s, structured=None):
    r = {'content': [text_content(s)], 'isError': False}
    if structured is not None:
        r['structuredContent'] = structured
    return r


# ────────────────────── 工具实现 ──────────────────────

def tool_doctor(args):
    rc, out, err, res = run_chx(['doctor'], timeout=120)
    if not res:
        return fail('环境自检失败：\n' + tail(out + '\n' + err))
    lines = ['环境自检：%s' % ('通过' if res.get('ok') else '有问题')]
    lines.append('  node            : %s' % (res.get('node') or '× 未找到'))
    lines.append('  playwright-core : %s' % (res.get('playwright_core') or '× 未找到'))
    lines.append('  浏览器          : %s' % (res.get('browser') or '× 未找到'))
    lines.append('  调试端口 9222   : %s' % ('已开（会复用该窗口）' if res.get('cdp_9222') else '未开（会自己拉起浏览器）'))
    lines.append('  归档根目录      : %s' % res.get('archive_root'))
    return done('\n'.join(lines), res)


def tool_status(args):
    rc, out, err, res = run_chx(['status'], timeout=120)
    if not res:
        return fail('读取状态失败：\n' + tail(out + '\n' + err))
    files = res.get('files') or {}
    lines = ['工作区：%s' % res.get('workspace')]
    for name in ('题目.txt', '作业截图.png', '答案模板.json', 'answers.json', 'quiz_filled.png'):
        info = files.get(name)
        lines.append('  %-16s %s' % (name, ('%s (%.1f KB)' % (info['mtime'], info['size'] / 1024.0)) if info else '× 不存在'))
    courses = res.get('courses') or []
    if courses:
        lines.append('已有课程：')
        for c in courses:
            lines.append('  - %s%s' % (c['course'], ('（已归档 %d 次）' % len(c['homeworks'])) if c['homeworks'] else ''))
    lines.append('下一步：%s' % res.get('next_step'))
    return done('\n'.join(lines), res)


def tool_browser(args):
    """打开/复用独立浏览器（脚本自己拉起，不需要用户手动开窗口）。"""
    cmd = ['browser']
    if args.get('restart'):
        cmd.append('--restart')
    if args.get('url'):
        cmd += ['--url', str(args['url'])]

    rc, out, err, res = run_chx(cmd, timeout=120)
    if not res or not res.get('ok'):
        return fail('打开浏览器失败（rc=%s）：\n%s' % (rc, tail(out + '\n' + err)))
    state = res.get('state')
    desc = {'reused': '复用已开的窗口', 'launched': '自动拉起新窗口'}.get(state, state)
    return done('浏览器就绪（%s），当前停在：%s\n你可以在窗口里登录/点进作业，然后调用 chaoxing_dump。'
                % (desc, res.get('url')), res)


def tool_dump(args):
    wait = int(args.get('wait_seconds') or 120)
    rc, out, err, res = run_chx(['dump'],
                                extra_env={'CHX_WAIT_SECONDS': wait, 'CHX_AFTER': 'exit'},
                                timeout=wait + 180)
    if not res:
        return fail('导出失败（rc=%s）：\n%s' % (rc, tail(out + '\n' + err)))
    if not res.get('ok'):
        return fail('导出失败（rc=%s）\n%s\n%s' % (rc, res.get('hint', ''), tail(out + '\n' + err)))
    c = res.get('counts') or {}
    lines = ['导出成功：共 %s 题' % res.get('total'),
             '  单选/多选 %s · 判断 %s · 填空 %s · 简答/计算 %s' % (c.get('single'), c.get('judge'), c.get('blank'), c.get('essay')),
             '文件：题目.txt / 作业截图.png / 答案模板.json',
             '下一步：调用 chaoxing_get_paper 取题目内容（内含截图）']
    return done('\n'.join(lines), res)


def tool_get_paper(args):
    """返回题目文本 + 作业截图（图片直接以 base64 塞进 content）。"""
    content = []

    txt_path = os.path.join(HERE, '题目.txt')
    if os.path.exists(txt_path):
        with io.open(txt_path, encoding='utf-8', errors='replace') as f:
            paper = f.read().strip()
        content.append(text_content('【题目.txt】\n' + (paper or '(空)')))
    else:
        content.append(text_content('【题目.txt】不存在 —— 先调用 chaoxing_dump'))

    tmpl_path = os.path.join(HERE, '答案模板.json')
    if os.path.exists(tmpl_path):
        with io.open(tmpl_path, encoding='utf-8', errors='replace') as f:
            content.append(text_content('【答案模板.json】\n' + f.read().strip()))

    png = os.path.join(HERE, '作业截图.png')
    if os.path.exists(png):
        size = os.path.getsize(png)
        if size <= MAX_IMAGE_BYTES:
            with open(png, 'rb') as f:
                content.append({'type': 'image',
                                'data': base64.b64encode(f.read()).decode('ascii'),
                                'mimeType': 'image/png'})
            content.append(text_content('【作业截图.png】已随本条结果附上（%.1f KB）。'
                                        '学习通题干有字体反爬，题目.txt 可能是乱码 —— 请以截图为准。' % (size / 1024.0)))
        else:
            content.append(text_content('【作业截图.png】体积 %.1f MB 超过上限，未内联。'
                                        '请直接用 Read 工具打开：%s' % (size / 1048576.0, png)))
    else:
        content.append(text_content('【作业截图.png】不存在'))

    return {'content': content, 'isError': False}


def tool_fill(args):
    answers = args.get('answers')
    if not isinstance(answers, dict):
        return fail('缺少 answers 参数（应为对象：{single:[], judge:[], blank:[], essay:[]}）')

    unknown = [k for k in answers if k not in ('single', 'judge', 'blank', 'essay', 'attachment')]
    if unknown:
        log('忽略未知字段: %s' % unknown)
        answers = {k: v for k, v in answers.items()
                   if k in ('single', 'judge', 'blank', 'essay', 'attachment')}

    dst = os.path.join(HERE, 'answers.json')
    if os.path.exists(dst):
        try:
            shutil.copy(dst, os.path.join(HERE, 'answers.prev.json'))
        except OSError as e:
            log('备份旧 answers.json 失败: %s' % e)
    with io.open(dst, 'w', encoding='utf-8') as f:
        f.write(json.dumps(answers, ensure_ascii=False, indent=2))
    log('已写入 answers.json: ' + json.dumps({k: len(v) for k, v in answers.items() if isinstance(v, list)}))

    wait = int(args.get('wait_seconds') or 120)
    rc, out, err, res = run_chx(['fill'],
                                extra_env={'CHX_WAIT_SECONDS': wait, 'CHX_AFTER': 'exit'},
                                timeout=wait + 300)
    if not res:
        return fail('填答失败（rc=%s）：\n%s' % (rc, tail(out + '\n' + err)))

    lines = ['填答结果（rc=%s）' % rc]
    if res.get('summary'):
        lines.append('  ' + res['summary'])
    f = res.get('files', {}).get('quiz_filled.png')
    lines.append('  截图：%s' % ('已生成 quiz_filled.png' if f else '未生成'))
    lines.append('提醒：脚本只点了「暂时保存」，**请人工核对后自己点「提交作业」**。')
    if rc != 0:
        lines.append('hint：rc=2 作答页超时；rc=3 部分题目未填成功。')
        lines.append(tail(out + '\n' + err))
    return done('\n'.join(lines), res) if rc == 0 else fail('\n'.join(lines))


def tool_archive(args):
    course = args.get('course')
    if not course:
        return fail('缺少 course 参数（课程名）。可先调用 chaoxing_status 看已有课程名。')
    cmd = ['archive', str(course)]
    if args.get('seq'):
        cmd.append(str(args['seq']))

    rc, out, err, res = run_chx(cmd, timeout=180)
    if not res or not res.get('ok'):
        return fail('归档失败（rc=%s）\n%s\n%s' % (rc, (res or {}).get('hint', ''), tail(out + '\n' + err)))
    return done('归档完成 → %s' % res.get('dest'), res)


# ────────────────────── 工具清单 ──────────────────────

TOOLS = [
    {
        'name': 'chaoxing_doctor',
        'title': '环境自检',
        'description': '检查 node / playwright-core / 浏览器 / 调试端口是否就绪。任何工具报错时先跑这个。',
        'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
        'annotations': {'readOnlyHint': True},
    },
    {
        'name': 'chaoxing_status',
        'title': '查看作业进度',
        'description': '查看当前工作区产物状态（题目/截图/答案/填答截图）和已有课程列表，并给出下一步建议。开始任何作业流程前先调用。',
        'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
        'annotations': {'readOnlyHint': True},
    },
    {
        'name': 'chaoxing_browser',
        'title': '打开浏览器',
        'description': '打开（或复用）学习通独立浏览器，窗口停在课程列表页。'
                       '脚本自己拉起、进程与调用方脱离，调用结束后窗口保留。'
                       'chaoxing_dump / chaoxing_fill 内部也会自动调用它，通常不必单独用。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'restart': {'type': 'boolean', 'description': '先关掉本项目 profile 的旧窗口再重新拉起（解决调试端口没开的问题）'},
                'url': {'type': 'string', 'description': '启动时打开的地址，默认学习通课程列表'},
            },
            'additionalProperties': False,
        },
    },
    {
        'name': 'chaoxing_dump',
        'title': '导出作业题目',
        'description': '从浏览器里已打开的作业作答页导出全部题目，生成 题目.txt / 作业截图.png / 答案模板.json。'
                       '会先自动确保浏览器就绪；页面识别兼容 dowork / doHomeWorkNew 等多种格式，'
                       '并会兜底识别「页面里真的有题目块」的标签页。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'wait_seconds': {'type': 'integer', 'description': '等待作答页出现的秒数，默认 120。用户说还没打开页面时给大一点。'}
            },
            'additionalProperties': False,
        },
    },
    {
        'name': 'chaoxing_get_paper',
        'title': '读取题目内容',
        'description': '读取已导出的题目：返回 题目.txt 文本、答案模板.json，以及作业截图的图片内容。'
                       '学习通题干有字体反爬，文字可能是乱码，**必须以截图为准**。',
        'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
        'annotations': {'readOnlyHint': True},
    },
    {
        'name': 'chaoxing_fill',
        'title': '自动填答',
        'description': '把答案写入 answers.json 并在浏览器里逐题填答、验证，最后点「暂时保存」并截图。'
                       '**不会点「提交作业」**，提交必须由人工在浏览器里确认。'
                       '字段规则：single=单选+多选（多选写 "AB"）、judge=判断（A=对/B=错）、blank=填空、essay=简答+计算，'
                       '均按题号顺序，数组长度必须与答案模板一致。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'answers': {
                    'type': 'object',
                    'description': '答案对象，形如 {"single":["B","A"],"judge":["A"],"blank":["语义"],"essay":["..."]}',
                    'properties': {
                        'single': {'type': 'array', 'items': {'type': 'string'}},
                        'judge': {'type': 'array', 'items': {'type': 'string'}},
                        'blank': {'type': 'array', 'items': {'type': 'string'}},
                        'essay': {'type': 'array', 'items': {'type': 'string'}},
                        'attachment': {'type': 'string', 'description': '可选的附件绝对路径'},
                    },
                    'additionalProperties': False,
                },
                'wait_seconds': {'type': 'integer', 'description': '等待作答页出现的秒数，默认 120。'},
            },
            'required': ['answers'],
            'additionalProperties': False,
        },
    },
    {
        'name': 'chaoxing_archive',
        'title': '归档作业',
        'description': '把本次产物（题目.txt、答案.txt 含解析）归档到 <上级目录>/课程作业/<课程名>/<第N次作业>/。'
                       '注意：题目.txt 会被下次导出覆盖，所以做完一次就应立刻归档。',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'course': {'type': 'string', 'description': '课程名，建议用 chaoxing_status 返回的已有课程名'},
                'seq': {'type': 'string', 'description': '作业次数，如 "第三次作业"；留空则自动递增'},
            },
            'required': ['course'],
            'additionalProperties': False,
        },
    },
]

HANDLERS = {
    'chaoxing_doctor': tool_doctor,
    'chaoxing_status': tool_status,
    'chaoxing_browser': tool_browser,
    'chaoxing_dump': tool_dump,
    'chaoxing_get_paper': tool_get_paper,
    'chaoxing_fill': tool_fill,
    'chaoxing_archive': tool_archive,
}


# ────────────────────── JSON-RPC 主循环 ──────────────────────

def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def send_result(msg_id, result):
    send({'jsonrpc': '2.0', 'id': msg_id, 'result': result})


def send_error(msg_id, code, message):
    send({'jsonrpc': '2.0', 'id': msg_id, 'error': {'code': code, 'message': message}})


def handle(msg):
    method = msg.get('method')
    msg_id = msg.get('id')
    params = msg.get('params') or {}

    if msg_id is None:
        return  # 通知，不需要回复

    if method == 'initialize':
        client_ver = params.get('protocolVersion')
        send_result(msg_id, {
            'protocolVersion': client_ver or DEFAULT_PROTOCOL,
            'capabilities': {'tools': {'listChanged': False}},
            'serverInfo': {'name': SERVER_NAME, 'version': SERVER_VERSION},
            'instructions': '学习通作业助手。标准流程：chaoxing_status → chaoxing_dump → chaoxing_get_paper → '
                            '（AI 解题）→ chaoxing_fill → 人工核对提交 → chaoxing_archive。',
        })
    elif method == 'ping':
        send_result(msg_id, {})
    elif method == 'tools/list':
        send_result(msg_id, {'tools': TOOLS})
    elif method == 'tools/call':
        name = params.get('name')
        arguments = params.get('arguments') or {}
        handler = HANDLERS.get(name)
        if not handler:
            send_error(msg_id, -32602, 'Unknown tool: %s' % name)
            return
        try:
            send_result(msg_id, handler(arguments))
        except Exception as e:
            log('tool %s 异常: %r' % (name, e))
            send_result(msg_id, fail('工具执行异常：%s: %s' % (type(e).__name__, e)))
    else:
        send_error(msg_id, -32601, 'Method not found: %s' % method)


def main():
    log('启动 %s v%s（工作区 %s）' % (SERVER_NAME, SERVER_VERSION, HERE))
    if not os.path.exists(CHX):
        log('警告：找不到 chx.py（%s）' % CHX)
    for raw in sys.stdin.buffer:
        line = raw.decode('utf-8', 'replace').strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError as e:
            log('收到非法 JSON，已忽略：%s' % e)
            continue
        try:
            handle(msg)
        except Exception as e:
            log('处理消息异常: %r' % e)
    log('stdin 关闭，退出')


if __name__ == '__main__':
    main()
