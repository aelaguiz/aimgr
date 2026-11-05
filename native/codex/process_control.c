/* Read-only process inventory for explicit MCP credential conversion.
 * The command refuses live affected consumers; it never signals processes
 * or controls their launchers. Results cross a private pipe only. */
#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <stdint.h>
#if defined(__linux__)
#include <dirent.h>
#include <fcntl.h>
#elif defined(__APPLE__)
#include <libproc.h>
#include <sys/sysctl.h>
#endif

struct process { pid_t pid,parent; char image[PATH_MAX],birth[80]; };

static int inspect(pid_t pid,struct process *value) {
    memset(value,0,sizeof(*value));value->pid=pid;
#if defined(__linux__)
    char file[64],buffer[4096];struct stat info;
    snprintf(file,sizeof(file),"/proc/%d",pid);
    if (stat(file,&info) || info.st_uid!=getuid()) return 0;
    snprintf(file,sizeof(file),"/proc/%d/exe",pid);
    ssize_t size=readlink(file,value->image,sizeof(value->image)-1);
    if (size<=0 || size>=(ssize_t)sizeof(value->image)-1) return 0;
    value->image[size]=0;
    snprintf(file,sizeof(file),"/proc/%d/stat",pid);
    FILE *input=fopen(file,"r");if (!input) return 0;
    char *read=fgets(buffer,sizeof(buffer),input);fclose(input);if (!read) return 0;
    char *end=strrchr(buffer,')');if (!end || end[1]!=' ') return 0;
    char *state=NULL,*field=strtok_r(end+2," ",&state);
    for (int index=3;field;index++,field=strtok_r(NULL," ",&state)) {
        if (index==4) value->parent=(pid_t)strtol(field,NULL,10);
        if (index==22) { snprintf(value->birth,sizeof(value->birth),"%llu",strtoull(field,NULL,10));return 1; }
    }
    return 0;
#elif defined(__APPLE__)
    struct proc_bsdinfo info;
    if (proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))!=sizeof(info)
        || info.pbi_uid!=getuid() || info.pbi_ruid!=getuid()
        || proc_pidpath(pid,value->image,sizeof(value->image))<=0) return 0;
    value->parent=(pid_t)info.pbi_ppid;
    snprintf(value->birth,sizeof(value->birth),"%llu:%llu",(unsigned long long)info.pbi_start_tvsec,(unsigned long long)info.pbi_start_tvusec);
    return 1;
#else
    return 0;
#endif
}

static void quoted(const char *value) {
    putchar('"');
    for (const unsigned char *p=(const unsigned char *)value;*p;p++) {
        if (*p=='"' || *p=='\\') { putchar('\\');putchar(*p); }
        else if (*p<32) printf("\\u%04x",*p);
        else putchar(*p);
    }
    putchar('"');
}

/* Private discovery pipe only. Never print argv to a terminal or diagnostics.
 * Birth identity lets discovery discard a PID that changed during its read. */
static int inventory(void) {
    if (isatty(STDOUT_FILENO)) return 125;
    pid_t *pids=NULL;int count=0;
#if defined(__linux__)
    DIR *directory=opendir("/proc");if (!directory) return 125;
    struct dirent *entry;
    while ((entry=readdir(directory))) {
        char *end=NULL;long pid=strtol(entry->d_name,&end,10);
        if (!end || *end || pid<=1 || pid>INT_MAX) continue;
        pid_t *next=realloc(pids,(size_t)(count+1)*sizeof(*pids));
        if (!next) { free(pids);closedir(directory);return 125; }
        pids=next;pids[count++]=(pid_t)pid;
    }
    closedir(directory);
#elif defined(__APPLE__)
    int capacity=proc_listallpids(NULL,0)+256;
    pids=calloc((size_t)capacity,sizeof(*pids));if (!pids) return 125;
    count=proc_listallpids(pids,capacity*(int)sizeof(*pids));
    if (count<0 || count>=capacity) { free(pids);return 125; }
#endif
    putchar('[');int first=1;
    for (int i=0;i<count;i++) {
        struct process value,after;
        if (!inspect(pids[i],&value)) continue;
        char *args=calloc(1024*1024+1,1);if (!args) { free(pids);return 125; }
        size_t size=0,offset=0;int argc=INT_MAX;
#if defined(__linux__)
        char file[64];snprintf(file,sizeof(file),"/proc/%d/cmdline",value.pid);
        int fd=open(file,O_RDONLY|O_CLOEXEC);
        if (fd>=0) { ssize_t n=read(fd,args,1024*1024);close(fd);if (n>0) size=(size_t)n; }
#elif defined(__APPLE__)
        int mib[]={CTL_KERN,KERN_PROCARGS2,value.pid};size=1024*1024;
        if (sysctl(mib,3,args,&size,NULL,0) || size<sizeof(argc)) size=0;
        else {
            memcpy(&argc,args,sizeof(argc));offset=sizeof(argc);
            while (offset<size && args[offset]) offset++;
            while (offset<size && !args[offset]) offset++;
        }
#endif
        if (!inspect(value.pid,&after) || strcmp(value.birth,after.birth) || strcmp(value.image,after.image)) { free(args);continue; }
        if (!first) putchar(',');
        first=0;
        printf("{\"pid\":%d,\"parent\":%d,\"birth\":",value.pid,value.parent);quoted(value.birth);
        fputs(",\"image\":",stdout);quoted(value.image);fputs(",\"args\":[",stdout);
        int index=0;
        while (offset<size && index<argc) {
            if (index++) putchar(',');
            quoted(args+offset);
            offset+=strnlen(args+offset,size-offset)+1;
        }
        fputs("]}",stdout);free(args);
    }
    free(pids);puts("]");return 0;
}

int main(int argc,char **argv) {
    if (getuid()!=0 && getuid()==geteuid() && argc==2 && !strcmp(argv[1],"--inventory")) return inventory();
    fputs("Codex maintenance process inventory requires its private read-only operation.\n",stderr);
    return 125;
}
