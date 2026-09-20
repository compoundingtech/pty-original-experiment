#include <arpa/inet.h>
#include <errno.h>
#include <libproc.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/socket.h>

/*
 * Private, release-sensitive Darwin backend for PTY accepted-socket ownership.
 *
 * argv: accepted-local-address accepted-local-port accepted-foreign-address
 *       accepted-foreign-port pid...
 * stdout: "owned PID", "not-owned", or "unavailable".
 *
 * Every requested PID must yield a complete descriptor table. A permission
 * failure, short libproc record, invalid argument, or allocation failure is
 * Unavailable rather than a false NotOwned.
 */

static int parse_port(const char *text, uint16_t *out) {
  char *end = NULL;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value <= 0 || value > 65535) {
    return 0;
  }
  *out = (uint16_t)value;
  return 1;
}

static int address_matches(
  const struct in_sockinfo *info,
  int family,
  const void *local_address,
  const void *foreign_address
) {
  if (family == AF_INET) {
    if ((info->insi_vflag & INI_IPV4) == 0) return 0;
    return memcmp(
      &info->insi_laddr.ina_46.i46a_addr4,
      local_address,
      sizeof(struct in_addr)
    ) == 0 && memcmp(
      &info->insi_faddr.ina_46.i46a_addr4,
      foreign_address,
      sizeof(struct in_addr)
    ) == 0;
  }
  if (family == AF_INET6) {
    if ((info->insi_vflag & INI_IPV6) == 0) return 0;
    return memcmp(
      &info->insi_laddr.ina_6,
      local_address,
      sizeof(struct in6_addr)
    ) == 0 && memcmp(
      &info->insi_faddr.ina_6,
      foreign_address,
      sizeof(struct in6_addr)
    ) == 0;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 6) {
    puts("unavailable");
    return 0;
  }

  int family = strchr(argv[1], ':') == NULL ? AF_INET : AF_INET6;
  if ((strchr(argv[3], ':') == NULL ? AF_INET : AF_INET6) != family) {
    puts("unavailable");
    return 0;
  }

  struct in6_addr local6;
  struct in6_addr foreign6;
  struct in_addr local4;
  struct in_addr foreign4;
  void *local_address = family == AF_INET ? (void *)&local4 : (void *)&local6;
  void *foreign_address = family == AF_INET ? (void *)&foreign4 : (void *)&foreign6;
  if (inet_pton(family, argv[1], local_address) != 1 ||
      inet_pton(family, argv[3], foreign_address) != 1) {
    puts("unavailable");
    return 0;
  }

  uint16_t local_port;
  uint16_t foreign_port;
  if (!parse_port(argv[2], &local_port) || !parse_port(argv[4], &foreign_port)) {
    puts("unavailable");
    return 0;
  }

  for (int arg = 5; arg < argc; arg++) {
    char *end = NULL;
    errno = 0;
    long parsed_pid = strtol(argv[arg], &end, 10);
    if (errno != 0 || end == argv[arg] || *end != '\0' || parsed_pid <= 0 || parsed_pid > INT32_MAX) {
      puts("unavailable");
      return 0;
    }
    int pid = (int)parsed_pid;
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (bytes <= 0 || bytes % (int)sizeof(struct proc_fdinfo) != 0) {
      puts("unavailable");
      return 0;
    }
    int capacity = bytes + 32 * (int)sizeof(struct proc_fdinfo);
    struct proc_fdinfo *fds = calloc(1, (size_t)capacity);
    if (fds == NULL) {
      puts("unavailable");
      return 0;
    }
    int read_bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, capacity);
    if (read_bytes <= 0 || read_bytes >= capacity || read_bytes % (int)sizeof(*fds) != 0) {
      free(fds);
      puts("unavailable");
      return 0;
    }

    int count = read_bytes / (int)sizeof(*fds);
    for (int index = 0; index < count; index++) {
      if (fds[index].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
      struct socket_fdinfo socket_info;
      int socket_bytes = proc_pidfdinfo(
        pid,
        fds[index].proc_fd,
        PROC_PIDFDSOCKETINFO,
        &socket_info,
        (int)sizeof(socket_info)
      );
      if (socket_bytes != (int)sizeof(socket_info)) {
        free(fds);
        puts("unavailable");
        return 0;
      }
      if (socket_info.psi.soi_kind != SOCKINFO_TCP ||
          socket_info.psi.soi_protocol != IPPROTO_TCP ||
          socket_info.psi.soi_family != family ||
          socket_info.psi.soi_proto.pri_tcp.tcpsi_state != TSI_S_ESTABLISHED) {
        continue;
      }
      const struct in_sockinfo *info = &socket_info.psi.soi_proto.pri_tcp.tcpsi_ini;
      if (ntohs((uint16_t)info->insi_lport) != local_port ||
          ntohs((uint16_t)info->insi_fport) != foreign_port) {
        continue;
      }
      if (address_matches(info, family, local_address, foreign_address)) {
        free(fds);
        printf("owned %d\n", pid);
        return 0;
      }
    }
    free(fds);
  }

  puts("not-owned");
  return 0;
}
