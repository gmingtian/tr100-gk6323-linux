#!/usr/bin/env python3
"""PC-side TR100 universal HiTool assistant (Python 3.11+, pyserial).

Run without arguments for the GUI, or:
  python assistant.py inspect --package PACKAGE --session NEW.json --port COM3
  python assistant.py apply --package PACKAGE --session NEW.json --port COM3

Inspect is read-only on eMMC. Apply is an explicit, separately invoked operation
which changes only bootargs, bootcmd and verify after complete revalidation.
"""
import argparse
import datetime
import json
from pathlib import Path
import queue
import sys
import threading

try:
    from . import serial_policy as policy
except ImportError:
    import serial_policy as policy


READY = ('先通过 TTL 停在原厂 fastboot# 提示符（115200 8N1）。\n'
         '检查前和配置前都需关闭 HiTool，并确认串口由本助手独占。\n'
         'HiTool 只烧写 kernel / rootfs；不要擦除全盘或勾选其他分区。')
COMPLETE = ('启动参数已保存；本助手没有重启设备。\n'
            '点击“首次设置串口终端”，手动输入 reset 或重新上电启动 Linux，按首次设置提示输入两次新密码。')


def serial_modules():
    try:
        import serial
        from serial.tools import list_ports
    except ImportError as error:
        raise policy.PolicyError('PC 缺少 pyserial。请在电脑运行：python -m pip install pyserial') from error
    return serial, list_ports


def open_connection(port):
    """Open a passive 115200 8N1 port: no reset, interrupt, newline or command."""
    if not port or not port.strip():
        raise policy.PolicyError('请选择串口 / specify --port')
    serial, _ = serial_modules()
    connection = serial.Serial(port=None, baudrate=115200, bytesize=8, parity='N',
                               stopbits=1, timeout=0.1, write_timeout=5,
                               xonxoff=False, rtscts=False, dsrdtr=False)
    try:
        connection.dtr = False
        connection.rts = False
        connection.port = port
        connection.open()
    except Exception:
        connection.close()
        raise
    return connection


class TerminalSession:
    """Serial terminal worker: opening/read operations never transmit bytes.

    UI input is queued only after Send/Enter or the explicit Ctrl+C action.
    Output and input are held only in memory, never in report files or logs.
    """
    def __init__(self, port):
        self.port = port
        self.events = queue.Queue()
        self.outgoing = queue.Queue()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._work, daemon=True)

    def start(self):
        self.thread.start()

    def send(self, value):
        self.outgoing.put(policy.encode_terminal_line(value))

    def interrupt(self):
        self.outgoing.put(b'\x03')

    def close(self):
        self.stop.set()

    def _work(self):
        connection = None
        try:
            connection = open_connection(self.port)
            self.events.put(('connected', None))
            while not self.stop.is_set():
                try:
                    while not self.stop.is_set():
                        data = self.outgoing.get_nowait()
                        if connection.write(data) != len(data):
                            raise OSError('串口未发送完整输入；已停止')
                except queue.Empty:
                    pass
                if not self.stop.is_set():
                    data = connection.read(4096)
                    if data:
                        self.events.put(('data', data))
        except Exception as error:
            self.events.put(('error', str(error)))
        finally:
            if connection is not None:
                connection.close()
            self.events.put(('closed', None))


def execute(action, package, session, port, progress=lambda message: None):
    """Complete a local-file validation before even opening the requested port."""
    if action not in ('inspect', 'apply'):
        raise policy.PolicyError('unknown assistant action')
    if not port or not port.strip():
        raise policy.PolicyError('请选择串口 / specify --port')
    session = Path(session)
    if action == 'inspect':
        if session.exists() or session.is_symlink():
            raise FileExistsError('检查报告必须使用新路径，不能覆盖已有文件：' + str(session))
        if not session.parent.is_dir():
            raise policy.PolicyError('报告上级目录不存在')
        report = None
    else:
        report = policy.read_session(session)
    progress('正在校验烧写包 SHA256（rootfs 超过 7 GiB，可能需要几分钟）…')
    manifest, digest = policy.load_manifest(package)
    progress('正在连接 TTL 并核对原厂 loader、环境和保护分区…')
    connection = open_connection(port)
    try:
        console = policy.SerialConsole(connection, timeout=30)
        console.connect()
        if action == 'inspect':
            result = policy.preflight(console, manifest, digest)
            policy.write_session(session, result)
            progress('检查通过。私有报告已保存；报告仅含环境文本和 CRC，不能替代完整原厂备份。')
        else:
            result = policy.apply(console, manifest, digest, report)
            progress(COMPLETE)
        return result
    finally:
        connection.close()


def gui(default_package, default_session='', default_port=''):
    try:
        import tkinter as tk
        from tkinter import filedialog, messagebox, ttk
    except ImportError as error:
        raise policy.PolicyError('此 Python 未安装 Tkinter；请安装 Tk 支持或使用 inspect/apply 命令行') from error
    root = tk.Tk()
    root.title('TR100 通用烧写助手 — 原机身份保留')
    root.minsize(760, 480)
    root.columnconfigure(1, weight=1)
    package = tk.StringVar(value=str(default_package))
    default_name = 'tr100-private-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '.json'
    session = tk.StringVar(value=default_session or str(Path.cwd() / default_name))
    port = tk.StringVar(value=default_port)
    status = tk.StringVar(value='尚未连接设备。先检查并保存本机报告，再使用 HiTool。')
    events = queue.Queue()
    busy = [False]

    ttk.Label(root, text=READY, justify='left', wraplength=720).grid(
        row=0, column=0, columnspan=3, sticky='w', padx=16, pady=16)
    ttk.Label(root, text='烧写包目录').grid(row=1, column=0, sticky='w', padx=16, pady=8)
    ttk.Entry(root, textvariable=package).grid(row=1, column=1, sticky='ew', padx=4)
    def choose_package():
        value = filedialog.askdirectory(title='选择含 install-manifest.json 的烧写包目录')
        if value:
            package.set(value)
    ttk.Button(root, text='选择目录', command=choose_package).grid(row=1, column=2, padx=16)
    ttk.Label(root, text='本机私有检查报告').grid(row=2, column=0, sticky='w', padx=16, pady=8)
    ttk.Entry(root, textvariable=session).grid(row=2, column=1, sticky='ew', padx=4)
    def choose_session():
        value = filedialog.askopenfilename(title='选择此前检查报告（首次检查可直接编辑新路径）',
                                           filetypes=[('JSON report', '*.json')])
        if value:
            session.set(value)
    ttk.Button(root, text='选择已有报告', command=choose_session).grid(row=2, column=2, padx=16)
    ttk.Label(root, text='TTL 串口').grid(row=3, column=0, sticky='w', padx=16, pady=8)
    ports = ttk.Combobox(root, textvariable=port)
    ports.grid(row=3, column=1, sticky='ew', padx=4)
    def refresh_ports():
        try:
            _, list_ports = serial_modules()
            names = [p.device for p in list_ports.comports()]
            ports['values'] = names
            if not port.get() and names:
                port.set(names[0])
        except policy.PolicyError as error:
            status.set(str(error))
    ttk.Button(root, text='刷新串口', command=refresh_ports).grid(row=3, column=2, padx=16)
    ttk.Label(root, text='报告包含原厂环境及 MAC，请私下保管。检查不会修改环境或闪存。\n'
              '烧写完成后先退出 HiTool，再重连 TTL 并停在原厂提示符，最后点击配置启动。',
              justify='left', wraplength=720).grid(row=4, column=0, columnspan=3,
                                                sticky='w', padx=16, pady=16)
    buttons = []
    def start(action):
        if busy[0]:
            return
        arguments = (action, package.get(), session.get(), port.get())
        if not all(arguments[1:]):
            messagebox.showerror('缺少输入', '请填写烧写包、报告路径及串口。')
            return
        busy[0] = True
        for button in buttons:
            button.configure(state='disabled')
        def worker():
            try:
                result = execute(*arguments, progress=lambda value: events.put(('progress', value)))
                events.put(('done', (action, result, arguments[2])))
            except Exception as error:
                events.put(('error', str(error)))
        threading.Thread(target=worker, daemon=True).start()
    inspect = ttk.Button(root, text='检查并备份', command=lambda: start('inspect'))
    inspect.grid(row=5, column=0, columnspan=2, sticky='ew', padx=(16, 8), pady=8)
    commit = ttk.Button(root, text='烧写完成后配置启动', command=lambda: start('apply'))
    commit.grid(row=5, column=2, sticky='ew', padx=(8, 16), pady=8)
    buttons.extend((inspect, commit))
    def open_terminal():
        if busy[0]:
            return
        if not port.get().strip():
            messagebox.showerror('缺少串口', '请先选择 TTL 串口并关闭 HiTool。')
            return
        busy[0] = True
        for button in buttons:
            button.configure(state='disabled')
        window = tk.Toplevel(root)
        window.title('首次设置串口终端 — ' + port.get())
        window.geometry('900x600')
        window.columnconfigure(0, weight=1)
        window.rowconfigure(1, weight=1)
        ttk.Label(window, text='请先关闭 HiTool。本终端不会自动启动、复位或发送命令，也不保存日志。\n'
                  '启动 Linux：手动输入 reset 并发送，或给盒子重新上电。\n'
                  '看到 TR100_FIRSTBOOT_PASSWORD_SETUP 后，在 New password / Retype 提示下各输入一次新密码，\n'
                  '等待 TR100_FIRSTBOOT_COMPLETE。输入默认隐藏；不要在原厂命令提示符输入密码。',
                  justify='left', wraplength=860).grid(row=0, column=0, columnspan=3,
                                                     sticky='w', padx=12, pady=12)
        output = tk.Text(window, state='disabled', wrap='word', font=('Courier', 10))
        output.grid(row=1, column=0, columnspan=3, sticky='nsew', padx=12)
        terminal_status = tk.StringVar(value='正在被动连接串口…')
        ttk.Label(window, textvariable=terminal_status).grid(row=2, column=0, columnspan=3,
                                                            sticky='w', padx=12, pady=8)
        entry = ttk.Entry(window, show='*')
        entry.grid(row=3, column=0, sticky='ew', padx=12, pady=8)
        terminal = TerminalSession(port.get())
        closing = [False]
        def send(event=None):
            value = entry.get()
            entry.delete(0, 'end')
            if closing[0] or str(send_button['state']) == 'disabled':
                return 'break'
            try:
                terminal.send(value)
            except policy.PolicyError as error:
                messagebox.showerror('输入未发送', str(error), parent=window)
            return 'break'
        send_button = ttk.Button(window, text='发送 / Enter', state='disabled', command=send)
        send_button.grid(row=3, column=1, padx=4, pady=8)
        interrupt_button = ttk.Button(window, text='发送 Ctrl+C', state='disabled', command=terminal.interrupt)
        interrupt_button.grid(row=3, column=2, padx=12, pady=8)
        entry.bind('<Return>', send)
        def close_terminal():
            closing[0] = True
            entry.delete(0, 'end')
            send_button.configure(state='disabled')
            interrupt_button.configure(state='disabled')
            terminal_status.set('正在关闭串口…')
            terminal.close()
        ttk.Button(window, text='关闭终端并释放串口', command=close_terminal).grid(
            row=4, column=0, columnspan=3, pady=10)
        window.protocol('WM_DELETE_WINDOW', close_terminal)
        def poll_terminal():
            try:
                while True:
                    kind, value = terminal.events.get_nowait()
                    if kind == 'connected' and not closing[0]:
                        terminal_status.set('已连接；只有点击发送 / Enter / Ctrl+C 才会发送数据。')
                        send_button.configure(state='normal')
                        interrupt_button.configure(state='normal')
                        entry.focus_set()
                    elif kind == 'data':
                        output.configure(state='normal')
                        output.insert('end', value.decode('utf-8', errors='replace').replace('\r', ''))
                        # Bound the in-memory screen; there is intentionally no transcript file.
                        if output.count('1.0', 'end-1c', 'chars')[0] > 200000:
                            output.delete('1.0', 'end-100000c')
                        output.see('end')
                        output.configure(state='disabled')
                    elif kind == 'error':
                        terminal_status.set('串口已停止：' + value)
                        messagebox.showerror('终端已停止', value, parent=window)
                    elif kind == 'closed':
                        window.destroy()
                        busy[0] = False
                        for button in buttons:
                            button.configure(state='normal')
                        status.set('串口终端已关闭，串口已释放。')
                        return
            except queue.Empty:
                pass
            root.after(100, poll_terminal)
        terminal.start()
        poll_terminal()
    terminal_button = ttk.Button(root, text='首次设置串口终端', command=open_terminal)
    terminal_button.grid(row=6, column=0, columnspan=3, sticky='ew', padx=16, pady=8)
    buttons.append(terminal_button)
    ttk.Label(root, textvariable=status, justify='left', wraplength=720).grid(
        row=7, column=0, columnspan=3, sticky='nw', padx=16, pady=16)
    root.rowconfigure(7, weight=1)
    def poll():
        try:
            while True:
                kind, value = events.get_nowait()
                if kind == 'progress':
                    status.set(value)
                else:
                    busy[0] = False
                    for button in buttons:
                        button.configure(state='normal')
                    if kind == 'error':
                        status.set('已停止：' + value)
                        messagebox.showerror('已停止，请勿继续烧写或启动', value)
                    else:
                        action, result, path = value
                        if action == 'inspect':
                            status.set('检查通过，原机 MAC：' + result['mac'] + '\n私有检查报告：' + path +
                                       '\n此报告仅备份环境文本和 CRC 证据；如需完整原厂恢复，请另外保存原厂分区备份。\n'
                                       '现在可关闭助手串口连接，打开 HiTool 烧写 kernel / rootfs。')
                        else:
                            status.set(COMPLETE)
        except queue.Empty:
            pass
        root.after(100, poll)
    def close():
        if busy[0]:
            messagebox.showinfo('操作进行中', '请等待检查或配置结束后再关闭窗口，避免中断串口事务。')
        else:
            root.destroy()
    root.protocol('WM_DELETE_WINDOW', close)
    refresh_ports()
    poll()
    root.mainloop()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', nargs='?', default='gui', choices=('gui', 'inspect', 'apply'))
    parser.add_argument('--package', type=Path, default=(Path(sys.executable).resolve().parent
                        if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent))
    parser.add_argument('--session', type=Path)
    parser.add_argument('--port')
    args = parser.parse_args(argv)
    try:
        if args.action == 'gui':
            gui(args.package, str(args.session) if args.session else '', args.port or '')
        else:
            if args.session is None or not args.port:
                parser.error('inspect/apply require --session and --port')
            result = execute(args.action, args.package, args.session, args.port,
                             progress=lambda value: print(value, file=sys.stderr, flush=True))
            # Never dump private factory environment or secrets to terminal/logs.
            print(json.dumps({'action': args.action, 'mac': result['mac'],
                              'session': str(args.session), 'saved': result.get('saved', False)},
                             ensure_ascii=True))
    except (policy.PolicyError, OSError, ValueError) as error:
        parser.exit(1, 'assistant: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
