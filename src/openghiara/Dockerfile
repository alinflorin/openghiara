FROM kasmweb/core-ubuntu-jammy:1.18.0-rolling-daily
USER root
ENV HOME /home/kasm-default-profile
ENV STARTUPDIR /dockerstartup
ENV INST_SCRIPTS $STARTUPDIR/install
WORKDIR $HOME
COPY ./README.md ./README.md
COPY ./custom_startup.sh /dockerstartup/custom_startup.sh
RUN chmod +x /dockerstartup/custom_startup.sh
COPY ./kasm_default_profile.sh /dockerstartup/kasm_default_profile.sh
COPY ./vnc_startup.sh /dockerstartup/vnc_startup.sh
COPY ./kasmvnc.yaml /etc/kasmvnc/kasmvnc.yaml











RUN chown 1000:0 $HOME
RUN $STARTUPDIR/set_user_permission.sh $HOME
ENV HOME /home/kasm-user
WORKDIR $HOME
RUN mkdir -p $HOME && chown -R 1000:0 $HOME
USER 1000
