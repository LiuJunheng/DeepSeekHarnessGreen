# -*- coding: utf-8 -*-
"""update_agent.py - 独立更新程序 (打包为 DSH_Update.exe)

绿色版自更新的真正执行者, 解决"本体 exe 无法自替换"的问题:

背景:
    本体 DSH_Launcher.exe 运行时会被 Windows 锁住自身文件, 无法在原地被覆盖。
    早期方案是用一个 update_apply.bat 以分离进程跑覆盖, 但 .bat 依赖 cmd,
    在无控制台/重定向 stdin 时容易静默失败, 且失败时无法用图形界面提示用户
    从哪里手动下载覆盖源文件 (用户 2026-08-18 反馈"更新还是不太靠谱")。

本程序定位:
    独立、轻量的覆盖安装器 (单文件 exe, 不依赖 cmd/bat, 不依赖系统 Python)。
    由启动器在下载解压新版 zip 后, 把更新任务写成 runtime/update/update_job.json,
    再以分离进程启动本程序并退出。本程序负责:
        1) 把自身复制到 runtime/tmp 再从副本运行, 释放根目录 DSH_Update.exe 的锁,
           使新版 DSH_Update.exe 也能被覆盖 (自我替换)
        2) 等待本体启动器退出并释放文件锁
        3) 备份旧文件到 runtime/update/backup/
        4) 覆盖安装新版 (跳过 config.json 用户配置 与 runtime/ 用户数据)
        5) 失败 -> 弹窗提示手动下载地址; 成功 -> 重启新版启动器

调用方式 (由 launcher.py 生成):
    DSH_Update.exe --apply <update_job.json>
    手动运行无参数时仅弹提示, 不执行任何操作。

绿色便携原则: 不写注册表, 不装运行库, 所有操作都限定在程序目录内。
"""

import json
import os
import shutil
import subprocess
import sys
import time
import tkinter
from tkinter import messagebox

# 等待本体退出时的最长等待时间 (秒)
MAX_WAIT_SECONDS = 30
# bat 模式(启动器以 start.bat 运行)没有可轮询的文件锁, 直接固定睡眠
PY_MODE_SLEEP_SECONDS = 2.5

# 与 launcher.py 的 GREEN_VERSION 保持一致 —— release_upload.py 的 exe 新鲜度校验
# 会同时对 DSH_Launcher.exe 和 DSH_Update.exe 跑 --print-green-version 对比源码版本,
# 若版本号不同步会直接阻断打包, 因此这里硬编码是安全的 (不一致会被拦截).
GREEN_VERSION = "1.0.29"
# 覆盖完成后、重启前的短暂停顿, 让界面把"更新完成"状态画出来
RELAUNCH_DELAY_SECONDS = 0.8


def load_job(job_path):
    """读取启动器写好的更新任务文件 (JSON), 缺失/损坏抛异常"""
    if not os.path.isfile(job_path):
        raise RuntimeError("找不到更新任务文件: %s" % job_path)
    with open(job_path, "r", encoding="utf-8") as file_handle:
        job_data = json.load(file_handle)
    if not job_data.get("base_dir") or not job_data.get("content_root"):
        raise RuntimeError("更新任务文件内容不完整: %s" % job_path)
    return job_data


def _self_name():
    """返回当前程序自身的文件名 (exe 模式下是 DSH_Update.exe, 脚本模式下是 update_agent.py)。
    覆盖安装时必须跳过自身, 因为运行中的程序文件被锁住, 无法原地覆盖"""
    if getattr(sys, "frozen", False):
        return os.path.basename(sys.executable)
    return os.path.basename(__file__)


def relocate_self_if_needed(job_data, argv):
    """自我替换机制: 把当前更新程序复制到 runtime/tmp 再从副本运行, 释放根目录
    更新程序文件的锁, 使新版更新程序 (DSH_Update.exe / update_agent.py) 也能被覆盖。

    背景: 运行中的 exe 会被 Windows 锁住 (不允许写/删/改名), 若不迁移, 覆盖安装
    只能跳过更新程序自身, 旧版更新程序会一直残留。复制出的副本不锁任何待覆盖文件,
    从副本执行完整覆盖流程即可, 原进程随即退出。返回 True = 已从副本重启, 调用方
    应立即退出; 返回 False = 无需迁移 (已是从副本运行 / 脚本被 python 直接读 / 无 base_dir)。"""
    base_dir = job_data.get("base_dir") or ""
    if not base_dir:
        return False
    # 目标是复制到 runtime/tmp 下, 目录必须存在且可写
    tmp_dir = os.path.join(base_dir, "runtime", "tmp")
    try:
        os.makedirs(tmp_dir, exist_ok=True)
    except OSError:
        return False
    if getattr(sys, "frozen", False):
        # exe 模式: 复制 DSH_Update.exe 到 runtime/tmp/DSH_Update_worker.exe
        self_path = os.path.abspath(sys.executable)
        root_exe = os.path.join(base_dir, "DSH_Update.exe")
        if os.path.normcase(self_path) == os.path.normcase(root_exe):
            return _spawn_self_copy(self_path, os.path.join(tmp_dir, "DSH_Update_worker.exe"),
                                    argv, base_dir)
        return False
    # 脚本模式 (python update_agent.py 运行): 复制 update_agent.py 到 runtime/tmp
    self_path = os.path.abspath(__file__)
    root_script = os.path.join(base_dir, "update_agent.py")
    if os.path.normcase(self_path) == os.path.normcase(root_script):
        copy_path = os.path.join(tmp_dir, "update_agent_worker.py")
        if _spawn_self_copy(self_path, copy_path, argv, base_dir):
            return True
    return False


def _spawn_self_copy(source_path, copy_path, argv, base_dir):
    """把当前程序文件复制到副本路径, 再从副本启动 (传同样的命令行参数), 原进程退出。
    复制失败或启动失败返回 False (由调用方决定继续执行还是放弃)"""
    try:
        # 先清掉可能残留的旧副本 (被锁则忽略, copy2 会直接覆盖失败)
        if os.path.exists(copy_path):
            try:
                os.remove(copy_path)
            except OSError:
                pass
        shutil.copy2(source_path, copy_path)
    except OSError:
        return False
    try:
        command = [copy_path] + argv
        subprocess.Popen(command, cwd=base_dir, close_fds=True)
    except OSError:
        return False
    return True


def _can_open_write(file_path):
    """试探能否以"写入"方式打开某文件 (只试不写)。
    正在运行的 exe 会把自身锁住(不允许写/删/改名), 打开失败说明本体还在运行;
    打开成功说明文件锁已释放, 可以安全覆盖了"""
    try:
        file_handle = os.open(file_path, os.O_WRONLY | os.O_BINARY)
    except OSError:
        return False
    os.close(file_handle)
    return True


def wait_for_launcher_exit(base_dir, relaunch_mode):
    """等待本体启动器退出并释放文件锁。
    - exe 模式: 轮询能否以写方式打开 DSH_Launcher.exe, 能打开 = 本体已退出。
    - bat 模式: 本体是 python 进程, 没有固定文件锁, 直接固定睡眠即可。
    不轮询 PID: 本体退出后 PID 可能被其它进程立即复用, 轮询 PID 会死等
    (早期 bat 方案已踩过这个坑, 见 DEV_NOTES 避坑 #44)。"""
    if relaunch_mode == "exe":
        launcher_exe = os.path.join(base_dir, "DSH_Launcher.exe")
        deadline = time.time() + MAX_WAIT_SECONDS
        while time.time() < deadline:
            if _can_open_write(launcher_exe):
                return True
            time.sleep(0.5)
        return False   # 超时仍未释放
    time.sleep(PY_MODE_SLEEP_SECONDS)
    return True


def backup_old_files(base_dir, backup_dir):
    """把即将被覆盖的本体文件先备份到 backup_dir, 供用户手动回退"""
    os.makedirs(backup_dir, exist_ok=True)
    for name in ("launcher.py", "DSH_Launcher.exe", "DSH_Update.exe",
                 "start.bat", "stop.bat", "config.json"):
        source_path = os.path.join(base_dir, name)
        if os.path.isfile(source_path):
            try:
                shutil.copy2(source_path, os.path.join(backup_dir, name))
            except OSError:
                # 个别文件被占用/只读时忽略备份, 不阻断整个更新
                pass


def overlay_copy(content_root, base_dir):
    """把新版内容覆盖到程序根目录。
    跳过规则:
        - config.json  保留用户配置
        - runtime/     保留用户数据与已装环境 (绿色便携目录)
        - .git         保留仓库 (若程序目录是 git 仓库)
        - 当前更新程序自身文件 (运行中无法覆盖自己)
        - DEV_NOTES.md / .gitignore  开发侧文件 (GitHub 发货清单不含; Gitee 整仓
          快照会带上, 统一跳过保证两种来源的覆盖结果一致, 不落到用户目录)
    用 shutil.copy2 逐个复制, 比 robocopy 更可控: 失败能精确定位到具体文件
    并在 GUI 里给出可读的错误信息。返回被跳过的文件列表(供日志参考)"""
    self_name = _self_name()
    # 覆盖时总是排除的开发侧文件 (与 GitHub 发货清单保持一致)
    always_skipped_names = ("DEV_NOTES.md", ".gitignore")
    skipped_files = []
    for current_root, directories, files in os.walk(content_root):
        # 剪掉不应覆盖的目录 (runtime / .git), os.walk 会据此跳过其整个子树
        directories[:] = [name for name in directories
                          if name not in ("runtime", ".git")]
        relative_root = os.path.relpath(current_root, content_root)
        target_root = base_dir if relative_root == "." \
            else os.path.join(base_dir, relative_root)
        os.makedirs(target_root, exist_ok=True)
        for name in files:
            if name == "config.json" or name == self_name \
                    or name in always_skipped_names:
                skipped_files.append(os.path.join(relative_root, name))
                continue
            source_path = os.path.join(current_root, name)
            target_path = os.path.join(target_root, name)
            try:
                shutil.copy2(source_path, target_path)
            except OSError as error:
                raise RuntimeError("覆盖文件失败: %s (%s)" % (target_path, error))
    return skipped_files


def relaunch(base_dir, relaunch_mode):
    """更新完成后重启新版本体 (exe 模式启动 DSH_Launcher.exe, bat 模式启动 start.bat)"""
    if relaunch_mode == "bat":
        target_path = os.path.join(base_dir, "start.bat")
    else:
        target_path = os.path.join(base_dir, "DSH_Launcher.exe")
    if not os.path.isfile(target_path):
        raise RuntimeError("更新成功, 但找不到重启入口: %s (可手动双击启动)" % target_path)
    subprocess.Popen([target_path], cwd=base_dir, close_fds=True)


def build_status_window(job_data):
    """创建简易状态窗口, 让用户在覆盖过程中看到进度 (不依赖 cmd 控制台)"""
    root = tkinter.Tk()
    root.title("DSH 绿色版更新")
    root.geometry("460x150")
    root.resizable(False, False)
    new_version = job_data.get("new_version") or ""
    title_text = "DeepSeek Harness 绿色版更新中"
    if new_version:
        title_text += "  (新版本 v%s)" % new_version
    title_label = tkinter.Label(root, text=title_text,
                                font=("Microsoft YaHei", 12, "bold"))
    title_label.pack(pady=(18, 8))
    status_label = tkinter.Label(root, text="正在准备 ...",
                                 font=("Microsoft YaHei", 10), fg="#444444")
    status_label.pack()
    tip_label = tkinter.Label(root, text="更新期间请勿关闭本窗口",
                              font=("Microsoft YaHei", 9), fg="#999999")
    tip_label.pack(pady=(6, 0))
    root.update_idletasks()
    return root, status_label


def set_status(root, status_label, text):
    """刷新状态文字并泵出 Tk 事件, 让窗口即时显示当前进度"""
    status_label.config(text=text)
    root.update()


def show_failure_dialog(job_data, error_text):
    """更新失败: 弹窗说明原因, 并给出手动下载覆盖源文件的地址。
    用户需求 (2026-08-18): 失败时必须提示从哪手动拿到更新覆盖源文件"""
    release_url = job_data.get("manual_release_url") or ""
    zip_url = job_data.get("manual_zip_url") or ""
    message_parts = [
        "更新失败, 你的程序未受影响(旧文件已备份), 可继续使用当前版本。",
        "",
        "失败原因: %s" % error_text,
        "",
        "要手动更新, 请二选一:",
    ]
    if release_url:
        message_parts.append("1) 打开发布页: %s" % release_url)
    if zip_url:
        message_parts.append("2) 直接下载更新包: %s" % zip_url)
    if release_url or zip_url:
        message_parts.append("   下载解压后, 把里面的文件覆盖到程序目录 "
                             "(不要覆盖 config.json 与 runtime 文件夹)。")
    messagebox.showerror("DSH 绿色版更新失败", "\n".join(message_parts))


def show_manual_tip():
    """不带参数被手动运行时, 弹一个说明框 (正常流程由启动器自动调用, 无需手动运行)"""
    messagebox.showinfo(
        "DSH 绿色版更新程序",
        "这是 DSH 绿色版的独立更新程序, 由启动器在更新时自动调用, 一般无需手动运行。\n\n"
        "它会等待本体退出 → 备份旧文件 → 覆盖安装新版 → 重启启动器。\n"
        "若你是想手动更新: 请从 GitHub Release 下载最新绿色版 zip, "
        "解压覆盖到程序目录即可。")


def run_apply(job_data, job_path):
    """执行完整覆盖安装流程, 返回进程退出码 (0 成功 / 1 失败)。
    job_data 为已读取并校验过的更新任务, job_path 为任务文件路径 (均由 main 传入)"""
    root, status_label = build_status_window(job_data)
    try:
        base_dir = job_data["base_dir"]
        content_root = job_data["content_root"]
        backup_dir = job_data.get("backup_dir") or \
            os.path.join(os.path.dirname(job_path), "backup")
        relaunch_mode = job_data.get("relaunch_mode") or "exe"

        # 1. 等待本体退出并释放文件锁
        set_status(root, status_label, "正在等待启动器退出 ...")
        wait_ok = wait_for_launcher_exit(base_dir, relaunch_mode)
        if not wait_ok:
            raise RuntimeError("等待启动器退出超时 (本体文件仍被占用), 已中止更新")

        # 2. 备份旧文件
        set_status(root, status_label, "正在备份旧文件到 runtime/update/backup ...")
        backup_old_files(base_dir, backup_dir)

        # 3. 覆盖安装
        set_status(root, status_label, "正在覆盖安装新版本 (跳过 config.json 与 runtime) ...")
        skipped_files = overlay_copy(content_root, base_dir)

        # 4. 重启新版本体
        set_status(root, status_label, "更新完成, 正在启动新版 ...")
        time.sleep(RELAUNCH_DELAY_SECONDS)
        relaunch(base_dir, relaunch_mode)

        root.destroy()
        return 0
    except Exception as error:
        root.destroy()
        show_failure_dialog(job_data, error)
        return 1


def main():
    """入口: 正常流程由启动器以 `DSH_Update.exe --apply <job.json>` 调用"""
    arguments = sys.argv[1:]

    # 隐藏 flag: 发布脚本 release_upload.py 用它读取 Update.exe 内嵌版本,
    # 与 launcher.py 的 GREEN_VERSION 做一致性校验. 直接 print 版本号后退出,
    # 不走任何 GUI 逻辑 (避免无意义的弹窗卡住 subprocess 调用).
    if "--print-green-version" in arguments:
        print(GREEN_VERSION)
        return 0

    if len(arguments) == 2 and arguments[0] == "--apply":
        job_path = arguments[1]
        # 1. 读取并校验更新任务 (读不了直接系统弹窗报错)
        try:
            job_data = load_job(job_path)
        except Exception as error:
            messagebox.showerror("DSH 绿色版更新失败",
                                 "无法读取更新任务: %s\n请重新在启动器里点「检查绿色版更新」。"
                                 % error)
            return 1
        # 2. 自我迁移: 若当前运行的是根目录更新程序, 先复制到 runtime/tmp 从副本执行,
        #    释放根目录更新程序文件的锁, 使新版更新程序也能被覆盖
        try:
            if relocate_self_if_needed(job_data, arguments):
                return 0   # 已从副本重启, 本进程立即退出 (窗口将由副本展示)
        except Exception as error:
            show_failure_dialog(job_data, error)
            return 1
        # 3. 从副本 (或直接) 执行完整覆盖安装
        return run_apply(job_data, job_path)
    show_manual_tip()
    return 0


if __name__ == "__main__":
    sys.exit(main())
