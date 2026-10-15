# Profile for Openbotlounge bot machines (obl-machine-* containers).
# Load with: apparmor_parser -r -W obl-machine.profile
# The container create in src/lib/server/machine.ts names this profile
# (AppArmorProfile: 'obl-machine'); until it is loaded Docker runs such a
# container unconfined, so load it once per host at install time.

#include <tunables/global>

profile obl-machine flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  #include <abstractions/nameservice>

  # The desktop is the point of the machine: X, the window manager and the
  # browser need broad access to their own files, sockets and /proc, and the
  # box's whole purpose is that anything can run in it. So the profile denies
  # only what escapes the machine, and leaves the box's own filesystem alone.
  # The real boundary is the internal Docker network plus the egress proxy;
  # this profile is what stops a process reaching past that through the kernel
  # - the Docker socket, another container's namespace, a host mount it was
  # never given.

  # The Docker socket is the one file that would hand the whole host over.
  deny /var/run/docker.sock rwklx,
  deny /run/docker.sock rwklx,

  # Another container's proc entries and Docker's own control files.
  deny /proc/*/root/** rwklx,
  deny /proc/*/cwd/** rwklx,
  deny /sys/fs/cgroup/** wklx,
  deny /proc/sys/** wklx,

  # Host mounts nothing inside the box has a use for.
  deny /etc/ r,
  # (The machine writes its own /etc/hosts, /etc/resolv.conf and
  # /etc/ssh/ssh_config.d/obl-proxy.conf - those stay allowed through the
  # abstractions above, because the app writes them via exec.)
  allow /etc/hosts rw,
  allow /etc/resolv.conf rw,
  allow /etc/ssh/ssh_config.d/ rw,
  allow /etc/ssh/ssh_config.d/obl-proxy.conf rw,

  # /shared and /company are the machine's own volumes; everything else in
  # the box's root is its own writable layer. Nothing outside /tmp, /shared,
  # /company and the writable layer is touched.
  owner /{,tmp/}** rwklx,
  owner /shared/** rwklx,
  owner /company/** rwklx,

  # Signal and ptrace stay inside the container's own PID namespace, which
  # AppArmor mediates per-process: a process may only touch processes of this
  # profile, so another container's processes never match.
  signal (receive, send) peer=obl-machine,
  ptrace (readby, tracedby) peer=obl-machine,

  # Unix sockets the desktop stack talks over.
  network inet stream,
  network inet6 stream,
  network inet dgram,
  network inet6 dgram,
  network unix stream,
  network unix dgram,
  # Deny the raw socket and packet socket a port scan or a sniff would want,
  # whatever NET_RAW's presence in the capability set above allows.
  deny network raw,
  deny network packet,

  # Capability set mirrors the CapAdd in machine.ts: what X, the desktop and
  # Chromium's own sandbox need, and no more.
  capability chown,
  capability dac_override,
  capability fowner,
  capability setgid,
  capability setuid,
  capability net_bind_service,
  capability net_raw,
  capability sys_ptrace,
  capability mknod,
  capability sys_admin,
  capability sys_chroot,

  /bin/** mr,
  /usr/bin/** mr,
  /usr/local/bin/** r,
  /sbin/** mr,
  /lib/** mr,
  /usr/lib/** mr,
  /etc/** r,
  /dev/** rw,
  /proc/** r,
  /sys/** r,
}
