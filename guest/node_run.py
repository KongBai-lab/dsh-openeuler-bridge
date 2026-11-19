#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""融合开发引擎（Linux guest）侧的无头节点，仅标准库。

由宿主网关驱动（插件 bridge.js，或可选的 Python 网关 gateway.py）：连上宿主 -> 握手 -> 收 exec/cancel -> 回 result。
命令并发执行（默认上限 4），支持取消排队中/执行中的命令，连接断开时清理子进程。

为什么是 guest 主动连宿主
--------------------------
融合开发引擎默认 NAT 网络，guest 出站到宿主网关（172.16.x.1）稳定；
反向（宿主直接连 guest）在 NAT 下不可靠。OpenDesk 的 headless node 也走这个方向。

部署
----
把本文件放到 guest 可见的共享目录（guest 内通常挂载为 ``/mnt/linux_share/...``），
在融合引擎终端执行：

    python3 node_run.py --host <宿主内网 IP> --token-file <token 文件>

``--host`` 省略时默认 127.0.0.1；自启脚本会用 guest 默认路由的下一跳推断后传入。
token 文件必须与网关侧配置的是同一份（内容由网关首次启动时生成，属敏感信息，不要提交到仓库）。

自启：``guest-autostart.sh``（供 ~/.bashrc 调用）或 ``install-systemd.sh``（systemd 服务）。
退出：Ctrl-C；或 ``pkill -f node_run.py``（卡死时先杀再重跑自启）。
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import fcntl
import json
import os
import pty
import signal
import struct
import subprocess
import termios
import platform
import sys
import time
from typing import Any, Dict, Optional

PROTOCOL = "dshm-linux-bridge/0.1"
DEFAULT_PORT = 19222
MAX_BYTES_DEFAULT = 1024 * 1024
MAX_LINE = 4 * 1024 * 1024  # 显式放大 StreamReader 行上限（默认 64 KiB 会被大结果撑爆）
DEFAULT_CONCURRENCY = 4


def log(msg: str) -> None:
    print("[node %s] %s" % (time.strftime("%H:%M:%S"), msg), file=sys.stderr, flush=True)


async def read_line(reader: asyncio.StreamReader, timeout: Optional[float]) -> Optional[Dict[str, Any]]:
    try:
        if timeout is None:
            raw = await reader.readline()
        else:
            raw = await asyncio.wait_for(reader.readline(), timeout=timeout)
    except asyncio.TimeoutError:
        return None
    except ValueError:
        return None
    except (asyncio.IncompleteReadError, ConnectionError):
        raise
    if not raw:
        # EOF 不是“空闲”，必须抛出去触发重连；否则会陷入发 ping 的忙循环
        raise ConnectionError("gateway closed connection")
    try:
        value = json.loads(raw.decode("utf-8", "replace"))
    except json.JSONDecodeError:
        return {"type": "__bad_json__"}
    return value if isinstance(value, dict) else {"type": "__bad_json__"}


def send(writer: asyncio.StreamWriter, obj: Dict[str, Any]) -> None:
    writer.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")


class NodeRunner:
    def __init__(self, args: argparse.Namespace, token: str):
        self.args = args
        self.token = token
        self.name = args.name or "%s-%s" % (platform.node() or "guest", platform.machine() or "?")
        self.tasks: Dict[Any, asyncio.Task] = {}
        self.procs: Dict[Any, asyncio.subprocess.Process] = {}
        self.sem: Optional[asyncio.Semaphore] = None
        self.send_lock: Optional[asyncio.Lock] = None
        self.shells: Dict[str, Any] = {}
        self.shell_seq = 0
        self.max_shells = 8
        self.bgs: Dict[str, Any] = {}
        self.bg_seq = 0

    async def send_msg(self, writer: asyncio.StreamWriter, obj: Dict[str, Any]) -> None:
        assert self.send_lock is not None
        async with self.send_lock:
            send(writer, obj)
            try:
                await writer.drain()
            except (ConnectionError, RuntimeError):
                pass

    async def run_once(self) -> None:
        # 每条连接重置并发资源（重连后从干净状态开始）
        self.sem = asyncio.Semaphore(max(1, int(self.args.max_concurrency)))
        self.send_lock = asyncio.Lock()
        self.tasks.clear()
        self.procs.clear()

        reader, writer = await asyncio.open_connection(self.args.host, self.args.port, limit=MAX_LINE)
        log("connected to %s:%s" % (self.args.host, self.args.port))
        await self.send_msg(writer, {
            "type": "hello", "role": "node", "token": self.token, "name": self.name,
            "meta": {"platform": platform.platform(), "machine": platform.machine(),
                     "python": platform.python_version(), "pid": os.getpid(),
                     "maxConcurrency": self.args.max_concurrency},
        })
        welcome = await read_line(reader, timeout=10.0)
        if not welcome or welcome.get("type") != "welcome":
            raise RuntimeError("handshake failed: %r" % (welcome,))
        log("registered as %r (gateway %s)" % (welcome.get("name"), welcome.get("protocol")))

        try:
            while True:
                msg = await read_line(reader, timeout=15.0)
                if msg is None:
                    # 空闲超时：发心跳，确认连接还活着
                    await self.send_msg(writer, {"type": "ping", "t": int(time.time() * 1000)})
                    continue
                mtype = msg.get("type")
                if mtype == "exec":
                    req_id = msg.get("id")
                    task = asyncio.create_task(self.run_exec(writer, msg))
                    self.tasks[req_id] = task
                    task.add_done_callback(lambda _t, rid=req_id: self.tasks.pop(rid, None))
                elif mtype == "cancel":
                    await self.cancel(msg.get("id"))
                elif mtype == "shell.open":
                    await self.shell_open(writer, msg)
                elif mtype == "shell.write":
                    await self.shell_write(writer, msg)
                elif mtype == "shell.read":
                    await self.shell_read(writer, msg)
                elif mtype == "shell.resize":
                    await self.shell_resize(writer, msg)
                elif mtype == "shell.close":
                    await self.shell_close(writer, msg)
                elif mtype == "bg.start":
                    await self.bg_start(writer, msg)
                elif mtype == "bg.status":
                    await self.bg_status(writer, msg)
                elif mtype == "bg.log":
                    await self.bg_log(writer, msg)
                elif mtype == "bg.stop":
                    await self.bg_stop(writer, msg)
                elif mtype == "pong":
                    continue
                elif mtype == "__bad_json__":
                    log("ignored invalid json line from gateway")
                else:
                    log("ignore gateway message type=%r" % (mtype,))
        finally:
            # 连接断开：取消排队/执行中的任务并确保子进程被回收
            for task in list(self.tasks.values()):
                if not task.done():
                    task.cancel()
            if self.tasks:
                await asyncio.gather(*self.tasks.values(), return_exceptions=True)
            for proc in list(self.procs.values()):
                if proc.returncode is None:
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
            self.tasks.clear()
            self.procs.clear()
            self._close_all_shells()
            await self._close_all_bgs()

    async def run_exec(self, writer: asyncio.StreamWriter, msg: Dict[str, Any]) -> None:
        assert self.sem is not None
        async with self.sem:
            await self.execute(writer, msg)

    async def execute(self, writer: asyncio.StreamWriter, msg: Dict[str, Any]) -> None:
        req_id = msg.get("id")
        cmd = str(msg.get("cmd") or "")
        cwd = msg.get("cwd") or self.args.cwd or os.path.expanduser("~")
        max_bytes = int(msg.get("maxBytes") or MAX_BYTES_DEFAULT)
        timeout_ms = msg.get("timeoutMs")
        timeout_s = float(timeout_ms) / 1000.0 if timeout_ms else None
        if timeout_s is not None:
            timeout_s = max(0.5, min(timeout_s, 3600.0))

        started = time.time()
        timed_out = False
        stdout = b""
        stderr = b""
        exit_code: Optional[int] = None
        error: Optional[str] = None
        proc: Optional[asyncio.subprocess.Process] = None
        try:
            if not os.path.isdir(cwd):
                raise RuntimeError("cwd 不存在: %s" % cwd)
            proc = await asyncio.create_subprocess_exec(
                "/bin/sh", "-c", cmd,
                cwd=cwd,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            self.procs[req_id] = proc
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
            except asyncio.TimeoutError:
                timed_out = True
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                stdout, stderr = await proc.communicate()
            exit_code = proc.returncode
        except asyncio.CancelledError:
            if proc is not None and proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                try:
                    await proc.wait()
                except Exception:
                    pass
            raise
        except Exception as exc:  # noqa: BLE001 - 回传可行动错误
            error = "%s: %s" % (type(exc).__name__, exc)
        finally:
            self.procs.pop(req_id, None)

        truncated = False
        if len(stdout) > max_bytes:
            stdout = stdout[:max_bytes]
            truncated = True
        if len(stderr) > max_bytes:
            stderr = stderr[:max_bytes]
            truncated = True

        await self.send_msg(writer, {
            "type": "result", "id": req_id, "ok": error is None and not timed_out,
            "exitCode": exit_code, "stdout": stdout.decode("utf-8", "replace"),
            "stderr": stderr.decode("utf-8", "replace"), "truncated": truncated,
            "timedOut": timed_out, "error": error,
            "durationMs": int((time.time() - started) * 1000),
            "cwd": cwd,
        })
        log("exec id=%r exit=%r %dms%s" % (req_id, exit_code, int((time.time() - started) * 1000),
                                           " TIMEOUT" if timed_out else ""))

    async def cancel(self, req_id: Any) -> None:
        proc = self.procs.get(req_id)
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        task = self.tasks.get(req_id)
        if task is not None and not task.done():
            task.cancel()
            log("cancelled exec id=%r" % (req_id,))

    # ---------- PTY 交互式会话 ----------
    def _shell_error(self, writer, msg, code: str, text: str) -> None:
        # 同步 send（在消息循环里调用，writer 可用）
        send(writer, {"type": "shell.error", "id": msg.get("id"), "code": code, "message": text})

    async def shell_open(self, writer: asyncio.StreamWriter, msg: Dict[str, Any]) -> None:
        if len(self.shells) >= self.max_shells:
            self._shell_error(writer, msg, "TOO_MANY_SHELLS", "交互会话已达上限 %d" % self.max_shells)
            return
        shell = str(msg.get("shell") or "bash")
        cols = max(20, min(int(msg.get("cols") or 120), 400))
        rows = max(5, min(int(msg.get("rows") or 30), 200))
        cwd = msg.get("cwd") or self.args.cwd or os.path.expanduser("~")
        try:
            master_fd, slave_fd = pty.openpty()
            fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            env = os.environ.copy()
            env["TERM"] = "xterm-256color"
            proc = subprocess.Popen(
                [shell],
                stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
                cwd=cwd, env=env, start_new_session=True,
            )
            os.close(slave_fd)
            self.shell_seq += 1
            sid = "s%d" % self.shell_seq
            try:
                pgid = os.getpgid(proc.pid)
            except ProcessLookupError:
                pgid = proc.pid
            try:
                os_sid = os.getsid(proc.pid)
            except ProcessLookupError:
                os_sid = proc.pid
            session = {"id": sid, "fd": master_fd, "proc": proc, "pgid": pgid, "sid": os_sid,
                       "buffer": bytearray(), "eof": False, "created": time.time()}
            self.shells[sid] = session
            asyncio.get_running_loop().add_reader(master_fd, self._pty_readable, session)
            await self.send_msg(writer, {"type": "shell.opened", "id": msg.get("id"), "sessionId": sid,
                                         "pid": proc.pid, "cols": cols, "rows": rows})
            log("shell opened %s (%s pid=%s)" % (sid, shell, proc.pid))
        except Exception as exc:  # noqa: BLE001
            self._shell_error(writer, msg, "SHELL_OPEN_FAILED", "%s: %s" % (type(exc).__name__, exc))

    def _pty_readable(self, session: Dict[str, Any]) -> None:
        try:
            data = os.read(session["fd"], 65536)
        except OSError:
            data = b""
        if not data:
            session["eof"] = True
            try:
                asyncio.get_running_loop().remove_reader(session["fd"])
            except Exception:
                pass
            return
        session["buffer"].extend(data)

    async def shell_write(self, writer: asyncio.StreamWriter, msg: Dict[str, Any]) -> None:
        sid = msg.get("sessionId")
        session = self.shells.get(sid)
        if session is None:
            self._shell_error(writer, msg, "NO_SESSION", "会话不存在: %s" % sid)
            return
        data = str(msg.get("data") or "")
        try:
            os.write(session["fd"], data.encode("utf-8", "surrogateescape"))
            await self.send_msg(writer, {"type": "shell.ack", "id": msg.get("id"), "sessionId": sid, "written": len(data)})
        except OSError as exc:
            self._shell_error(writer, msg, "SHELL_WRITE_FAILED", str(exc))

    async def shell_read(self, writer: asyncio.StreamWriter, msg: Dict[str, Any]) -> None:
        sid = msg.get("sessionId")
        session = self.shells.get(sid)
        if session is None:
            self._shell_error(writer, msg, "NO_SESSION", "会话不存在: %s" % sid)
            return
        max_bytes = max(1, min(int(msg.get("maxBytes") or 65536), 1024 * 1024))
        chunk = bytes(session["buffer"][:max_bytes])
        del session["buffer"][:max_bytes]
        eof = session["eof"] and not session["buffer"]
        await self.send_msg(writer, {"type": "shell.data", "id": msg.get("id"), "sessionId": sid,
                                     "data": base64.b64encode(chunk).decode("ascii"),
                                     "eof": eof, "pending": len(session["buffer"])})

    async def shell_resize(self, writer: asyncio.StreamWriter, msg: Dict[str, Any]) -> None:
        sid = msg.get("sessionId")
        session = self.shells.get(sid)
        if session is None:
            self._shell_error(writer, msg, "NO_SESSION", "会话不存在: %s" % sid)
            return
        cols = max(20, min(int(msg.get("cols") or 120), 400))
        rows = max(5, min(int(msg.get("rows") or 30), 200))
        try:
            fcntl.ioctl(session["fd"], termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            await self.send_msg(writer, {"type": "shell.ack", "id": msg.get("id"), "sessionId": sid,
                                         "cols": cols, "rows": rows})
        except OSError as exc:
            self._shell_error(writer, msg, "SHELL_RESIZE_FAILED", str(exc))

    async def shell_close(self, writer: asyncio.StreamWriter, msg: Dict[str, Any]) -> None:
        sid = msg.get("sessionId")
        session = self.shells.pop(sid, None)
        if session is None:
            self._shell_error(writer, msg, "NO_SESSION", "会话不存在: %s" % sid)
            return
        exit_code = self._terminate_shell(session)
        await self.send_msg(writer, {"type": "shell.closed", "id": msg.get("id"), "sessionId": sid,
                                     "exitCode": exit_code})
        log("shell closed %s exit=%r" % (sid, exit_code))

    def _kill_session(self, os_sid: Optional[int], sig: int) -> None:
        """杀掉整个 session（bash 的交互式作业会自建进程组，单 killpg 抓不到后台作业）。"""
        if not os_sid:
            return
        try:
            entries = [int(p) for p in os.listdir("/proc") if p.isdigit()]
        except OSError:
            return
        for pid in entries:
            if pid == os.getpid():
                continue
            try:
                if os.getsid(pid) == os_sid:
                    os.kill(pid, sig)
            except (ProcessLookupError, PermissionError, OSError):
                continue

    def _terminate_shell(self, session: Dict[str, Any]) -> Optional[int]:
        try:
            asyncio.get_running_loop().remove_reader(session["fd"])
        except Exception:
            pass
        proc = session["proc"]
        pgid = session.get("pgid") or proc.pid
        os_sid = session.get("sid")
        # 交互式 bash 的后台作业在独立进程组，单 killpg 抓不到；按 session 杀
        self._kill_session(os_sid, signal.SIGTERM)
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            self._kill_session(os_sid, signal.SIGKILL)
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
        try:
            os.close(session["fd"])
        except OSError:
            pass
        return proc.poll()

    def _close_all_shells(self) -> None:
        for session in list(self.shells.values()):
            try:
                self._terminate_shell(session)
            except Exception:
                pass
        self.shells.clear()

    # ---------- 后台任务 + 流式日志 ----------
    def _bg_dir(self) -> str:
        d = getattr(self.args, "bg_log_dir", "") or os.path.expanduser("~/.dshm-bg")
        os.makedirs(d, exist_ok=True)
        return d

    async def bg_start(self, writer: asyncio.StreamWriter, msg: Dict[str, Any]) -> None:
        cmd = str(msg.get("cmd") or "")
        if not cmd.strip():
            self._shell_error(writer, msg, "BAD_REQUEST", "cmd 不能为空")
            return
        cwd = msg.get("cwd") or self.args.cwd or os.path.expanduser("~")
        self.bg_seq += 1
        bg_id = "b%d" % self.bg_seq
        log_path = os.path.join(self._bg_dir(), "%s.log" % bg_id)
        try:
            log_file = open(log_path, "wb")
            proc = await asyncio.create_subprocess_shell(
                cmd, cwd=cwd,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
            )
            try:
                os_sid = os.getsid(proc.pid)
            except ProcessLookupError:
                os_sid = proc.pid
            task = {"id": bg_id, "proc": proc, "file": log_file, "path": log_path,
                    "sid": os_sid, "started": time.time(), "exit": None,
                    "pump": None, "waiter": None}
            self.bgs[bg_id] = task
            task["pump"] = asyncio.create_task(self._bg_pump(task))
            task["waiter"] = asyncio.create_task(self._bg_wait(task))
            await self.send_msg(writer, {"type": "bg.started", "id": msg.get("id"), "bgId": bg_id,
                                         "pid": proc.pid, "logPath": log_path, "startedAt": task["started"]})
            log("bg started %s pid=%s cmd=%r" % (bg_id, proc.pid, cmd[:80]))
        except Exception as exc:  # noqa: BLE001
            try:
                log_file.close()
            except Exception:
                pass
            self._shell_error(writer, msg, "BG_START_FAILED", "%s: %s" % (type(exc).__name__, exc))

    async def _bg_pump(self, task: Dict[str, Any]) -> None:
        proc = task["proc"]
        f = task["file"]
        try:
            while True:
                data = await proc.stdout.read(8192)
                if not data:
                    break
                f.write(data)
                f.flush()
        except Exception:
            pass
        finally:
            try:
                f.close()
            except Exception:
                pass

    async def _bg_wait(self, task: Dict[str, Any]) -> None:
        try:
            task["exit"] = await task["proc"].wait()
        except Exception:
            task["exit"] = -1

    async def bg_status(self, writer: asyncio.StreamWriter, msg: Dict[str, Any]) -> None:
        want = msg.get("bgId")
        rows = []
        for bg_id, task in self.bgs.items():
            if want and bg_id != want:
                continue
            rows.append({
                "bgId": bg_id, "pid": task["proc"].pid,
                "running": task["proc"].returncode is None,
                "exitCode": task["exit"], "startedAt": task["started"],
                "logPath": task["path"],
            })
        await self.send_msg(writer, {"type": "bg.status", "id": msg.get("id"), "tasks": rows})

    async def bg_log(self, writer: asyncio.StreamWriter, msg: Dict[str, Any]) -> None:
        bg_id = msg.get("bgId")
        task = self.bgs.get(bg_id)
        if task is None:
            self._shell_error(writer, msg, "NO_BG", "后台任务不存在: %s" % bg_id)
            return
        try:
            offset = max(0, int(msg.get("offset") or 0))
        except (TypeError, ValueError):
            offset = 0
        max_bytes = max(1, min(int(msg.get("maxBytes") or 65536), 1024 * 1024))
        try:
            size = os.path.getsize(task["path"])
            with open(task["path"], "rb") as fh:
                fh.seek(offset)
                chunk = fh.read(max_bytes)
        except OSError as exc:
            self._shell_error(writer, msg, "BG_LOG_FAILED", str(exc))
            return
        next_offset = offset + len(chunk)
        eof = task["exit"] is not None and next_offset >= size
        await self.send_msg(writer, {"type": "bg.log", "id": msg.get("id"), "bgId": bg_id,
                                     "data": base64.b64encode(chunk).decode("ascii"),
                                     "nextOffset": next_offset, "size": size, "eof": eof,
                                     "exitCode": task["exit"]})

    async def bg_stop(self, writer: asyncio.StreamWriter, msg: Dict[str, Any]) -> None:
        bg_id = msg.get("bgId")
        task = self.bgs.pop(bg_id, None)
        if task is None:
            self._shell_error(writer, msg, "NO_BG", "后台任务不存在: %s" % bg_id)
            return
        self._kill_bg(task)
        try:
            await asyncio.wait_for(task["proc"].wait(), timeout=3)
        except asyncio.TimeoutError:
            pass
        for key in ("pump", "waiter"):
            t = task.get(key)
            if t is not None and not t.done():
                t.cancel()
        await self.send_msg(writer, {"type": "bg.stopped", "id": msg.get("id"), "bgId": bg_id,
                                     "exitCode": task["exit"]})

    def _kill_bg(self, task: Dict[str, Any]) -> None:
        proc = task["proc"]
        self._kill_session(task.get("sid"), signal.SIGTERM)
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        if proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass

    async def _close_all_bgs(self) -> None:
        for task in list(self.bgs.values()):
            try:
                self._kill_bg(task)
            except Exception:
                pass
        for task in list(self.bgs.values()):
            for key in ("pump", "waiter"):
                t = task.get(key)
                if t is not None and not t.done():
                    t.cancel()
            try:
                task["file"].close()
            except Exception:
                pass
        self.bgs.clear()

    async def run_forever(self) -> None:
        delay = 2.0
        while True:
            try:
                await self.run_once()
                delay = 2.0
                log("gateway connection closed; reconnecting in %.0fs" % delay)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - 单次异常不应杀死节点
                log("connect/run failed: %s: %s; retry in %.0fs"
                    % (type(exc).__name__, exc, delay))
            await asyncio.sleep(delay)
            delay = min(30.0, delay * 2)


async def amain(args: argparse.Namespace) -> int:
    token = args.token
    if not token and args.token_file:
        with open(args.token_file, "r", encoding="utf-8") as f:
            token = f.read().strip()
    if not token:
        log("error: 缺少 token（--token 或 --token-file）")
        return 2
    runner = NodeRunner(args, token)
    log("protocol=%s host=%s port=%s name=%s concurrency=%d"
        % (PROTOCOL, args.host, args.port, runner.name, args.max_concurrency))
    try:
        await runner.run_forever()
    except asyncio.CancelledError:
        pass
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="融合开发引擎侧 DSHM 无头节点（仅标准库）")
    parser.add_argument("--host", default="127.0.0.1", help="宿主网关地址（NAT 下通常是 172.16.x.1）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--token-file", default="")
    parser.add_argument("--token", default=os.environ.get("DSHM_LINUX_TOKEN"))
    parser.add_argument("--name", default="")
    parser.add_argument("--cwd", default="")
    parser.add_argument("--max-concurrency", type=int, default=DEFAULT_CONCURRENCY,
                        help="并发执行上限（默认 4；超过的请求排队）")
    parser.add_argument("--bg-log-dir", default="", help="后台任务日志目录（默认 ~/.dshm-bg）")
    args = parser.parse_args(argv)
    try:
        return asyncio.run(amain(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
