# -*- coding: utf-8 -*-
"""通用作业归档工具（学习通作业助手）

把「写作业\\」目录下当次的产物归档到：
    <上级目录>/课程作业/<课程名>/<第N次作业>/

归档内容：
    题目.txt        （chaoxing_dump.js 导出，原样搬）
    答案.txt        （题目 + 答案 + 解题解析，期末复习版）

用法：
    py archive_homework.py                        # 交互式：一步步问
    py archive_homework.py "数据库原理与应用" "第三次作业"
    py archive_homework.py "数据库原理与应用"      # 作业次数自动递增
"""
import io
import json
import os
import re
import shutil
import sys

# 便携化：默认归档到「学习通作业助手」的上一级目录下的 课程作业
# （例：D:/你的目录/学习通作业助手/写作业 → D:/你的目录/课程作业）
_DEFAULT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '课程作业'))
ROOT = os.environ.get('CHX_ARCHIVE_ROOT') or _DEFAULT_ROOT
SRC_DIR = os.path.dirname(os.path.abspath(__file__))          # 归档工具\
WS_DIR = os.path.join(os.path.dirname(SRC_DIR), '写作业')      # ..\写作业\

# 题型 -> answers.json 里的字段名（2026-10-18 扩展：兼容考试页各种题型标签）
TYPE_KEY = {
    '单选题': 'single',
    '多选题': 'single',
    '选择题': 'single',
    '判断题': 'judge',
    '填空题': 'blank',
    '简答题': 'essay',
    '计算题': 'essay',
    '论述题': 'essay',
    '问答题': 'essay',
    '名词解释': 'essay',
    '阅读理解': 'single',
}


def type_key(t, has_options=False):
    """模糊判定题型归属；未知题型按有没有选项来决定（有选项=选择，无选项=简答）。"""
    s = str(t or '')
    if '判断' in s:
        return 'judge'
    if '填空' in s:
        return 'blank'
    if re.search(r'单选|多选|选择|阅读|理解', s):
        return 'single'
    if re.search(r'简答|计算|论述|写作|翻译|问答|名词|案例|分析', s):
        return 'essay'
    if s in TYPE_KEY:
        return TYPE_KEY[s]
    return 'single' if has_options else 'essay'
ORDER = ['single', 'judge', 'blank', 'essay']


def parse_paper(txt):
    """解析 题目.txt → [{num, type, text, options}]"""
    items = []
    cur = None
    for raw in txt.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        # 题干行：以 "数字. (题型)" 开头
        m = re.match(r'^\s*(\d+)\.\s*\(([^)]+)\)\s*(.*)$', line)
        if m:
            if cur:
                items.append(cur)
            num = int(m.group(1))
            t = m.group(2).strip()
            rest = m.group(3).strip()
            # dump 脚本会把题号+题型重复一遍，去掉前缀冗余
            rest = re.sub(r'^\d+\.\s*\([^)]+\)\s*', '', rest)
            cur = {'num': num, 'type': t, 'text': rest, 'options': []}
            continue
        # 选项行：缩进 3 空格（顺带清掉 "A A 内容" 这种字母重复）
        if line.startswith('   ') and cur is not None:
            opt = line.strip()
            opt = re.sub(r'^([A-H])\s+\1\s+', r'\1 ', opt)
            cur['options'].append(opt)
    if cur:
        items.append(cur)
    return items


def fmt_judge(v):
    """判断题 A/B → 对/错"""
    s = str(v).strip().upper()
    if s in ('A', 'TRUE', '对', '正确', 'T'):
        return '对'
    if s in ('B', 'FALSE', '错', '错误', 'F'):
        return '错'
    return v


def load_explain():
    """读取 解析.json（题号 → 解析文本），没有就返回空 dict。"""
    p = os.path.join(WS_DIR, '解析.json')
    if not os.path.exists(p):
        return {}
    try:
        d = json.load(io.open(p, encoding='utf-8'))
        return {str(k): str(v) for k, v in d.items()}
    except Exception:
        return {}


def build_md(items, ans):
    """生成纯文本 答案.txt：题目下面直接跟答案（+ 解析，若有）。
    2026-10-18 按用户要求：弃用 md/json，复习就看这一个 txt。"""
    explain = load_explain()
    counters = {'single': 0, 'judge': 0, 'blank': 0, 'essay': 0}
    out = ['作业题目与答案（复习版）', '=' * 40, '']
    n_exp = 0
    for it in items:
        key = type_key(it['type'], bool(it.get('options')))
        out.append('第 %d 题（%s）' % (it['num'], it['type']))
        out.append('题干：%s' % (it['text'] or '(题干缺失)'))
        for o in it['options']:
            out.append('  ' + o)
        if key and key in ans:
            idx = counters[key]
            arr = ans.get(key) or []
            if idx < len(arr):
                val = arr[idx]
                if key == 'judge':
                    val = fmt_judge(val)
                if isinstance(val, list):
                    val = '、'.join(str(x) for x in val)
                out.append('【答案】%s' % val)
            else:
                out.append('【答案】(未提供)')
            counters[key] = idx + 1
        else:
            out.append('【答案】(未识别题型：%s)' % it['type'])
        exp = explain.get(str(it['num']))
        if exp:
            n_exp += 1
            out.append('【解析】%s' % exp.strip())
        out.append('-' * 40)
    # 尾部统计
    parts = ['%s %d 题' % (k, counters[k]) for k in ORDER if counters[k]]
    out.append('统计：' + ('，'.join(parts) if parts else '无'))
    if explain:
        out.append('解析覆盖：%d/%d 题' % (n_exp, len(items)))
    return '\n'.join(out)


def next_seq(course_dir):
    """自动推算下一次是第几次作业"""
    cn = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
          '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}
    mx = 0
    if os.path.isdir(course_dir):
        for d in os.listdir(course_dir):
            m = re.search(r'第([0-9一二三四五六七八九十]+)次作业', d)
            if m:
                s = m.group(1)
                mx = max(mx, int(s) if s.isdigit() else cn.get(s, 0))
    return '第%s次作业' % {1: '一', 2: '二', 3: '三', 4: '四', 5: '五',
                          6: '六', 7: '七', 8: '八', 9: '九'}.get(mx + 1, str(mx + 1))


def pick_course():
    """列出已有课程，可复用或新建"""
    exist = sorted(d for d in os.listdir(ROOT)
                   if os.path.isdir(os.path.join(ROOT, d))) if os.path.isdir(ROOT) else []
    if not exist:
        return input('课程名（如 数据库原理与应用）：').strip()
    print('已有课程：')
    for i, d in enumerate(exist, 1):
        print('  %d) %s' % (i, d))
    print('  0) 新建其他课程')
    c = input('选择序号或直接输入课程名：').strip()
    if c.isdigit():
        n = int(c)
        if 1 <= n <= len(exist):
            return exist[n - 1]
    return c or '未命名课程'


def main():
    argv = [a for a in sys.argv[1:]]
    # 非交互模式（AI / 自动流程用）：不弹任何 input()
    auto_yes = ('--yes' in argv) or ('-y' in argv) or os.environ.get('CHX_NONINTERACTIVE') == '1'
    args = [a for a in argv if not a.startswith('-')]

    if not args and auto_yes:
        print('[ERROR] 非交互模式必须提供课程名：archive_homework.py "课程名" ["第N次作业"]')
        return 2

    course = args[0] if len(args) >= 1 else pick_course()
    if not course:
        print('课程名为空，取消。')
        return 1
    # 文件夹名合法化：Windows 不允许 \ / : * ? " < > |
    course = re.sub(r'[\\/:*?"<>|]', '_', course).strip().rstrip('.') or '未命名课程'

    course_dir = os.path.join(ROOT, course)
    if len(args) >= 2:
        seq = args[1]
        seq = re.sub(r'[\\/:*?"<>|]', '_', seq).strip()
    else:
        auto = next_seq(course_dir)
        seq = auto if auto_yes else (input('作业次数（回车使用 %s）：' % auto).strip() or auto)

    dst = os.path.join(course_dir, seq)
    os.makedirs(dst, exist_ok=True)

    src_paper = os.path.join(WS_DIR, '题目.txt')
    src_ans = os.path.join(WS_DIR, 'answers.json')
    src_png = os.path.join(WS_DIR, 'quiz_filled.png')

    if not os.path.exists(src_paper):
        print('[ERROR] 未找到 题目.txt —— 请先双击「写作业\\一键-导出题目.bat」')
        return 1

    txt = io.open(src_paper, encoding='utf-8').read()
    items = parse_paper(txt)

    ans = {}
    if os.path.exists(src_ans):
        ans = json.load(io.open(src_ans, encoding='utf-8'))
    else:
        print('[WARN] 未找到 answers.json，只归档题目。')

    # 2026-10-18：只留 题目.txt + 答案.txt（题目下跟答案+解析）；截图/json/md 一律不归档
    content = build_md(items, ans)
    io.open(os.path.join(dst, '答案.txt'), 'w', encoding='utf-8').write(content)
    shutil.copy(src_paper, os.path.join(dst, '题目.txt'))

    print('归档完成 ->', dst)
    for f in sorted(os.listdir(dst)):
        p = os.path.join(dst, f)
        print('  %-24s %.1f KB' % (f, os.path.getsize(p) / 1024.0))
    print()
    print('提示：下次导出题目会覆盖 写作业\\题目.txt，所以每次作业做完记得立刻归档。')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        print('FATAL:', e)
        sys.exit(1)
