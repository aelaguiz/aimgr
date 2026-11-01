// Synthetic root-owned resources verify the installed helper preserves group access.
#include <sys/types.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <membership.h>
#include <uuid/uuid.h>
#include <unistd.h>
#include <pwd.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
extern int __initgroups(int, const gid_t *, uid_t);
#define REQUIRE(x) do { if (!(x)) { perror(#x); exit(1); } } while (0)
int main(int argc, char **argv) {
  REQUIRE(geteuid()==0);
  struct passwd *u=getpwnam("ec2-user"); REQUIRE(u);
  uid_t uid=u->pw_uid;
  REQUIRE(argc >= 4);
  int base[64], count=argc-3; REQUIRE(count>0 && count<=16);
  for(int i=0;i<count;i++)base[i]=atoi(argv[i+3]);
  gid_t inherited[16]; int n=0;
  for(int i=0;i<count;i++){int seen=0;for(int j=0;j<n;j++)if(inherited[j]==(gid_t)base[i])seen=1;if(!seen){REQUIRE(n<16);inherited[n++]=base[i];}}
  for(gid_t gid=65001;n<16;gid++)inherited[n++]=gid;
  uuid_t user_uuid, group_uuid; int is_member=0;
  REQUIRE(mbr_uid_to_uuid(uid,user_uuid)==0);
  REQUIRE(mbr_gid_to_uuid(12,group_uuid)==0);
  REQUIRE(mbr_check_membership(user_uuid,group_uuid,&is_member)==0 && is_member==1);
  const char *root=argv[1];
  mkdir(root,0755); REQUIRE(chmod(root,0755)==0);
  char created_path[512]; snprintf(created_path,sizeof(created_path),"%s/created-shm",root);
  int created_fd=open(created_path,O_CREAT|O_TRUNC|O_RDWR,0600); REQUIRE(created_fd>=0);
  REQUIRE(fchown(created_fd,uid,u->pw_gid)==0); close(created_fd);
  gid_t resources[]={12,20,65001,65002}; int shms[4], sockets[4];
  char script[512]; snprintf(script,sizeof(script),"%s/check.py",root);
  FILE *f=fopen(script,"w"); REQUIRE(f);
  fprintf(f,"import os,ctypes,socket,json,subprocess\nc=ctypes.CDLL(None,use_errno=True)\nc.shmat.restype=ctypes.c_void_p\nc.shmat.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_int]\nc.shmdt.argtypes=[ctypes.c_void_p]\nassert os.getuid()==%u and os.getgid()==64084 and os.getegid()==64084\nraw=c.getgroups;raw.argtypes=[ctypes.c_int,ctypes.POINTER(ctypes.c_uint32)];raw.restype=ctypes.c_int;groups=(ctypes.c_uint32*16)();count=raw(16,groups);assert count==16;explicit=list(groups[:count]);assert 65001 in explicit and 65002 in explicit\n",uid);
  for(int i=0;i<4;i++){
    char file[512],sock[104];snprintf(file,sizeof(file),"%s/g%u",root,resources[i]);snprintf(sock,sizeof(sock),"%s/s%u",root,resources[i]);
    int fd=open(file,O_CREAT|O_TRUNC|O_RDWR,0660);REQUIRE(fd>=0);REQUIRE(fchown(fd,0,resources[i])==0);REQUIRE(fchmod(fd,0660)==0);close(fd);
    sockets[i]=socket(AF_UNIX,SOCK_STREAM,0);REQUIRE(sockets[i]>=0);struct sockaddr_un addr={0};addr.sun_family=AF_UNIX;strcpy(addr.sun_path,sock);unlink(sock);REQUIRE(bind(sockets[i],(struct sockaddr*)&addr,sizeof(addr))==0);REQUIRE(chown(sock,0,resources[i])==0);REQUIRE(chmod(sock,0660)==0);REQUIRE(listen(sockets[i],4)==0);
    shms[i]=shmget(IPC_PRIVATE,4096,IPC_CREAT|0600);REQUIRE(shms[i]>=0);struct shmid_ds ds;REQUIRE(shmctl(shms[i],IPC_STAT,&ds)==0);ds.shm_perm.gid=resources[i];ds.shm_perm.mode=0660;REQUIRE(shmctl(shms[i],IPC_SET,&ds)==0);
    fprintf(f,"with open('%s','a') as f:f.write('group access\\n')\ns=socket.socket(socket.AF_UNIX);s.connect('%s');s.close()\np=c.shmat(%d,None,0);assert p not in (None,ctypes.c_void_p(-1).value),ctypes.get_errno();assert c.shmdt(p)==0\n",file,sock,shms[i]);
  }
  fprintf(f,"created=c.shmget(0,4096,0o1000|0o660);assert created>=0\nwith open('%s','w') as f:f.write(str(created))\nprint(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'explicitGroups':explicit,'inheritedGroupCount':16,'omittedVerifiedGroup':12,'groupOnlyFiles':True,'unixSockets':True,'sysvSharedMemory':True}))\n",created_path);
  fclose(f); REQUIRE(chmod(script,0644)==0);
  pid_t child=fork();REQUIRE(child>=0);
  if(child==0){REQUIRE(__initgroups(n,inherited,uid)==0);REQUIRE(setgid(u->pw_gid)==0);REQUIRE(setuid(uid)==0);execl("/opt/aimgr-claude-proxy/darwin_launch","darwin_launch","mac_a",argv[2],"--","/bin/bash","-c","exec /usr/bin/python3 \"$1\"","--",script,(char*)NULL);_exit(127);}
  int status; REQUIRE(waitpid(child,&status,0)==child);
  int created=-1; FILE *created_file=fopen(created_path,"r"); REQUIRE(created_file);
  if(fscanf(created_file,"%d",&created)==1 && created>=0){
    struct shmid_ds ds; REQUIRE(shmctl(created,IPC_STAT,&ds)==0);
    REQUIRE(ds.shm_perm.uid==uid && ds.shm_perm.gid==64084);
    pid_t reader=fork(); REQUIRE(reader>=0);
    if(reader==0){REQUIRE(__initgroups(n,inherited,uid)==0);REQUIRE(setgid(u->pw_gid)==0);REQUIRE(setuid(uid)==0);void *memory=shmat(created,NULL,0);REQUIRE(memory!=(void*)-1);REQUIRE(shmdt(memory)==0);_exit(0);}
    int reader_status; REQUIRE(waitpid(reader,&reader_status,0)==reader);
    REQUIRE(WIFEXITED(reader_status) && WEXITSTATUS(reader_status)==0);
    REQUIRE(shmctl(created,IPC_RMID,NULL)==0);
    puts("{\"inheritedGroupCount\":16,\"existingGroupResources\":true,\"createdSysvGid\":64084,\"ordinarySameUidConsumer\":true}");
  }
  fclose(created_file); unlink(created_path);
  for(int i=0;i<4;i++){shmctl(shms[i],IPC_RMID,NULL);close(sockets[i]);char file[512],sock[104];snprintf(file,sizeof(file),"%s/g%u",root,resources[i]);snprintf(sock,sizeof(sock),"%s/s%u",root,resources[i]);unlink(file);unlink(sock);}
  unlink(script);rmdir(root);
  return WIFEXITED(status)?WEXITSTATUS(status):125;
}
